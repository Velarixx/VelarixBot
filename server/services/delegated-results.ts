// Durable task-backed delegate_bot result + outbox machine (#150 P0).
// Delivery claims stored receipts only and never invokes startTurn / sendTurn
// or enqueues a worker lane. Result durability precedes every delivery attempt.
import {
  type DeliveryFailureCode,
  type RunFailureCode,
} from "../contracts.ts";
import type { Message } from "../store.ts";
import type { Repositories } from "../repositories/index.ts";
import {
  DEFAULT_CLAIM_LEASE_MS,
  LedgerError,
  type AgentTaskDelivery,
  type AgentTaskRun,
  type RunBoundIdentity,
  type RunTerminalOutcome,
  type SealedRunResult,
} from "../repositories/agent-task-runs.ts";
import type { PutFixedResult } from "../repositories/messages.ts";
import type { AgentTask } from "../agent-tasks.ts";
import type { Broadcast } from "./events.ts";

export interface DelegatedBotLookup {
  id: string;
  name: string;
  color?: string;
  threadId: string;
}

export interface DelegatedResultsService {
  createPending(input: {
    taskId: string;
    workerBotId: string;
    workerThreadId: string;
    sourceBotId: string;
    sourceThreadId: string;
    parentThreadId: string;
    roomThreadId?: string | null;
    now?: number;
  }): AgentTaskRun;
  bindRunning(input: {
    identity: RunBoundIdentity;
    turnId: string;
    providerInstanceId: string;
    providerModel: string;
    startedAt: number;
  }): AgentTaskRun;
  recordProgress(input: { identity: RunBoundIdentity; text: string; now: number }): AgentTaskRun;
  finalize(input: {
    identity: RunBoundIdentity;
    result: SealedRunResult;
    assertedHash?: string;
    now: number;
    workerName?: string;
    workerColor?: string;
  }): { run: AgentTaskRun; deliveries: AgentTaskDelivery[]; task: AgentTask | null };
  get(runId: string): AgentTaskRun | null;
  getRunningForThread(workerThreadId: string): AgentTaskRun | null;
  getPendingForThread(workerThreadId: string): AgentTaskRun | null;
  identityOf(run: AgentTaskRun): RunBoundIdentity;
  pumpDue(now?: number): { delivered: number; failed: number; published: number };
  retryFailed(deliveryId: string, now?: number):
    | { ok: true; delivery: AgentTaskDelivery }
    | { ok: false; status: number; error: string; code: string };
  reconcileOnBoot(now?: number): { interrupted: number; republished: number };
  stampSealedProgress(): void;
  tick(now?: number): void;
}

export function createDelegatedResultsService(deps: {
  repos: Repositories;
  now?: () => number;
  broadcast?: Broadcast;
  lookupBot?: (id: string) => DelegatedBotLookup | null;
  owner?: string;
}): DelegatedResultsService {
  const runs = deps.repos.agentTaskRuns;
  const messages = deps.repos.messages;
  const clock = deps.now ?? (() => Date.now());
  const owner = deps.owner ?? "delivery-pump";

  function identityOf(run: AgentTaskRun): RunBoundIdentity {
    return {
      runId: run.id,
      taskId: run.taskId,
      workerBotId: run.workerBotId,
      workerThreadId: run.workerThreadId,
      sourceBotId: run.sourceBotId,
      sourceThreadId: run.sourceThreadId,
      parentThreadId: run.parentThreadId,
      roomThreadId: run.roomThreadId,
      attempt: run.attempt,
      turnId: run.turnId,
      providerInstanceId: run.providerInstanceId,
      providerModel: run.providerModel,
    };
  }

  function payloadFromDelivery(delivery: AgentTaskDelivery): Omit<Message, "id" | "at"> {
    const parsed = JSON.parse(delivery.payloadJson) as Omit<Message, "id" | "at">;
    return parsed;
  }

  function progressStampFromLedger(
    run: AgentTaskRun,
    deliveries: AgentTaskDelivery[],
  ): { status: NonNullable<Message["report"]>["status"]; failureCode?: string } | null {
    if (run.executionState === "pending" || run.executionState === "running") return null;
    const permanent = deliveries.filter((row) => row.deliveryState === "failed" || row.deliveryState === "rejected");
    if (permanent.length) {
      return {
        status: "delivery_failed",
        failureCode: permanent[0]?.failureCode ?? run.failureCode ?? undefined,
      };
    }
    const allDelivered = deliveries.length > 0 && deliveries.every((row) => row.deliveryState === "delivered");
    if (allDelivered) {
      return {
        status: run.terminalOutcome === "failed" ? "failed" : "terminal",
        ...(run.failureCode ? { failureCode: run.failureCode } : {}),
      };
    }
    const pendingFailure = deliveries.find((row) => row.failureCode)?.failureCode;
    return {
      status: "pending",
      ...(pendingFailure || run.failureCode ? { failureCode: pendingFailure ?? run.failureCode ?? undefined } : {}),
    };
  }

  function stampProgressFromLedger(run: AgentTaskRun): void {
    const deliveries = runs.listDeliveriesForRun(run.id);
    const stamp = progressStampFromLedger(run, deliveries);
    if (!stamp) return;
    const threads = new Set<string>([run.sourceThreadId, run.parentThreadId]);
    if (run.roomThreadId) threads.add(run.roomThreadId);
    for (const delivery of deliveries) threads.add(delivery.destinationThreadId);
    for (const threadId of threads) {
      for (const message of messages.forThread(threadId)) {
        if (message.report?.taskId !== run.taskId || message.report.kind !== "progress") continue;
        if (message.report.status === stamp.status && (message.report.failureCode ?? undefined) === (stamp.failureCode ?? undefined)) {
          continue;
        }
        const patched = messages.patch(threadId, message.id, {
          report: {
            ...message.report,
            status: stamp.status,
            ...(stamp.failureCode ? { failureCode: stamp.failureCode } : {}),
          },
        });
        if (patched) deps.broadcast?.({ kind: "message.patch", threadId, message: patched });
      }
    }
  }

  function stampSealedProgress(): void {
    for (const run of runs.listSealed()) stampProgressFromLedger(run);
  }

  function stampRunById(runId: string): void {
    const run = runs.get(runId);
    if (run) stampProgressFromLedger(run);
  }

  function projectTaskDelivery(taskId: string, deliveryState: NonNullable<AgentTask["deliveryState"]>, now: number): AgentTask | null {
    const current = deps.repos.agentTasks.get(taskId);
    if (!current) return null;
    return deps.repos.agentTasks.update(taskId, { deliveryState, updatedAt: now });
  }

  function deliverOne(now: number): "delivered" | "failed" | "none" {
    const claimed = runs.claim({ now, owner, leaseMs: DEFAULT_CLAIM_LEASE_MS });
    if (!claimed) return "none";
    const { delivery, token } = claimed;
    const putAndAck = deps.repos.db.transaction((): { put: PutFixedResult; acked?: AgentTaskDelivery } => {
      const put = messages.putFixed(delivery.destinationThreadId, delivery.messageId, payloadFromDelivery(delivery));
      if (put.status === "inserted" || put.status === "verified") {
        const acked = runs.ack({ deliveryId: delivery.id, token, now });
        return { put, acked };
      }
      return { put };
    });
    let outcome: { put: PutFixedResult; acked?: AgentTaskDelivery };
    try {
      outcome = putAndAck();
    } catch (error) {
      const code: DeliveryFailureCode = error instanceof LedgerError && error.code === "stale_claim"
        ? "conflict_retry"
        : "io_error";
      runs.failDelivery({ deliveryId: delivery.id, token, failureCode: code, now });
      stampRunById(delivery.runId);
      return "failed";
    }
    if (outcome.put.status === "missing_thread") {
      runs.failDelivery({ deliveryId: delivery.id, token, failureCode: "destination_unavailable", now });
      stampRunById(delivery.runId);
      return "failed";
    }
    if (outcome.put.status === "conflict") {
      const code: DeliveryFailureCode = outcome.put.code === "thread_mismatch" ? "identity_mismatch" : "payload_mismatch";
      runs.failDelivery({ deliveryId: delivery.id, token, failureCode: code, now });
      stampRunById(delivery.runId);
      return "failed";
    }
    if (!outcome.acked) {
      runs.failDelivery({ deliveryId: delivery.id, token, failureCode: "io_error", now });
      stampRunById(delivery.runId);
      return "failed";
    }
    const run = runs.get(delivery.runId);
    if (run) stampProgressFromLedger(run);
    if (run) projectTaskDelivery(run.taskId, "delivered", now);
    deps.broadcast?.({
      kind: "message",
      threadId: delivery.destinationThreadId,
      message: outcome.put.message,
    });
    if (run) {
      const task = deps.repos.agentTasks.get(run.taskId);
      if (task) deps.broadcast?.({ kind: "task", task });
    }
    runs.markPublished({ deliveryId: delivery.id, now });
    return "delivered";
  }

  function pumpDue(now = clock()): { delivered: number; failed: number; published: number } {
    let delivered = 0;
    let failed = 0;
    let published = 0;
    for (let i = 0; i < 32; i++) {
      const result = deliverOne(now);
      if (result === "none") break;
      if (result === "delivered") delivered += 1;
      else failed += 1;
    }
    for (const delivery of runs.listUnpublished()) {
      const existing = messages.find(delivery.destinationThreadId, delivery.messageId);
      if (!existing) continue;
      deps.broadcast?.({ kind: "message", threadId: delivery.destinationThreadId, message: existing });
      runs.markPublished({ deliveryId: delivery.id, now });
      published += 1;
    }
    return { delivered, failed, published };
  }

  function reconcileOnBoot(now = clock()): { interrupted: number; republished: number } {
    let interrupted = 0;
    for (const run of runs.listNonterminal()) {
      if (run.executionState === "pending") {
        continue;
      }
      const text = run.progressJson ? ((JSON.parse(run.progressJson) as { text?: string }).text ?? "") : "";
      try {
        runs.finalize({
          identity: identityOf(run),
          result: {
            text,
            outcome: "interrupted",
            failureCode: "interrupted",
          },
          now,
        });
        interrupted += 1;
      } catch (error) {
        if (!(error instanceof LedgerError)) throw error;
      }
    }
    stampSealedProgress();
    const { published } = pumpDue(now);
    stampSealedProgress();
    return { interrupted, republished: published };
  }

  return {
    createPending(input) {
      return runs.createPending(input);
    },
    bindRunning(input) {
      return runs.bindRunning(input);
    },
    recordProgress(input) {
      return runs.recordProgress(input);
    },
    finalize(input) {
      const worker = deps.lookupBot?.(input.identity.workerBotId);
      const sealed = runs.finalize({
        ...input,
        workerName: input.workerName ?? worker?.name,
        workerColor: input.workerColor ?? worker?.color,
      });
      stampProgressFromLedger(sealed.run);
      return sealed;
    },
    get: (runId) => runs.get(runId),
    getRunningForThread: (threadId) => runs.getRunningForThread(threadId),
    getPendingForThread: (threadId) => runs.getPendingForThread(threadId),
    identityOf,
    pumpDue,
    retryFailed(deliveryId, now = clock()) {
      try {
        const delivery = runs.retryFailed({ deliveryId, now });
        stampRunById(delivery.runId);
        pumpDue(now);
        stampRunById(delivery.runId);
        return { ok: true as const, delivery: runs.getDelivery(delivery.id) ?? delivery };
      } catch (error) {
        if (error instanceof LedgerError && error.code === "not_found") {
          return { ok: false as const, status: 404, error: "delivery not found", code: error.code };
        }
        if (error instanceof LedgerError && error.code === "not_failed") {
          return { ok: false as const, status: 409, error: "only stored failed deliveries can be retried", code: error.code };
        }
        throw error;
      }
    },
    reconcileOnBoot,
    stampSealedProgress,
    tick(now) {
      pumpDue(now ?? clock());
    },
  };
}

export function classifyAssigneeFailure(detail?: string): { outcome: RunTerminalOutcome; failureCode: RunFailureCode } {
  const value = (detail ?? "").trim().toLowerCase();
  if (value === "interrupted" || value === "cancelled" || value === "canceled") {
    return { outcome: "interrupted", failureCode: "interrupted" };
  }
  return { outcome: "failed", failureCode: "provider_error" };
}

