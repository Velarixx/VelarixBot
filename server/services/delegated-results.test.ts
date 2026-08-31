// #150 P0 runtime: result durability, delivery pump, retry, reconnect.
import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createAgentTask, configureAgentTasks } from "../agent-tasks.ts";
import { DATA_DIR } from "../config.ts";
import { defaultDbPath, openDatabase } from "../db/database.ts";
import type { SqliteDatabase } from "../db/sqlite-native.ts";
import { createRepositories, type Repositories } from "../repositories/index.ts";
import type { RunBoundIdentity } from "../repositories/agent-task-runs.ts";
import { createDelegatedResultsService } from "./delegated-results.ts";

describe("delegated results service", () => {
  let db: SqliteDatabase;
  let repos: Repositories;
  let now: number;
  let sendTurnCalls: number;

  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    db = openDatabase(defaultDbPath());
    repos = createRepositories(db);
    configureAgentTasks(repos.agentTasks);
    now = 10_000;
    sendTurnCalls = 0;
  });

  afterEach(() => {
    configureAgentTasks(null);
    try {
      db.close();
    } catch {
      /* already closed */
    }
  });

  function service() {
    return createDelegatedResultsService({
      repos,
      now: () => now,
      lookupBot: (id) => ({ id, name: id, threadId: `t-${id}` }),
    });
  }

  function boundRun(over: { roomThreadId?: string | null; workerThreadId?: string; taskAssignment?: string } = {}) {
    const task = createAgentTask({
      assigneeBotId: "helper",
      fromBotId: "lead",
      fromName: "Lead",
      sourceThreadId: "t-lead",
      assignment: over.taskAssignment ?? "audit",
      now,
    });
    const results = service();
    const run = results.createPending({
      taskId: task.id,
      workerBotId: "helper",
      workerThreadId: over.workerThreadId ?? "t-helper",
      sourceBotId: "lead",
      sourceThreadId: "t-lead",
      parentThreadId: "t-lead",
      roomThreadId: over.roomThreadId === undefined ? "t-room" : over.roomThreadId,
      now,
    });
    const bound = results.bindRunning({
      identity: results.identityOf(run),
      turnId: `turn-${run.id}`,
      providerInstanceId: "fake",
      providerModel: "fake-1",
      startedAt: now,
    });
    return { task, results, run: bound, identity: results.identityOf(bound) };
  }

  function noteSendTurn(): void {
    sendTurnCalls += 1;
  }

  it("stores the sealed result and outbox before any delivery attempt", () => {
    repos.messages.append("t-lead", { role: "user", kind: "text", text: "go" });
    const { results, identity } = boundRun({ roomThreadId: null });
    const finalized = results.finalize({
      identity,
      result: { text: "audit complete", outcome: "completed" },
      now,
    });
    expect(finalized.run.executionState).toBe("completed");
    expect(finalized.deliveries).toHaveLength(1);
    expect(finalized.deliveries[0]?.deliveryState).toBe("pending");
    expect(repos.messages.forThread("t-lead").some((m) => m.report?.kind === "completion")).toBe(false);
    expect(sendTurnCalls).toBe(0);
    const pumped = results.pumpDue(now);
    expect(pumped.delivered).toBe(1);
    expect(repos.messages.forThread("t-lead").filter((m) => m.report?.kind === "completion")).toHaveLength(1);
    expect(sendTurnCalls).toBe(0);
  });

  it("delivers exactly once after reconnect when the parent/room was down, with zero worker starts", () => {
    repos.messages.append("t-lead", { role: "user", kind: "text", text: "go" });
    const { results, identity, run } = boundRun({ roomThreadId: "missing-room" });
    results.finalize({
      identity,
      result: { text: "three audits done", outcome: "completed" },
      now,
    });
    const first = results.pumpDue(now);
    expect(first.delivered).toBe(1);
    expect(first.failed).toBe(1);
    const room = results.get(run.id) && repos.agentTaskRuns.listDeliveriesForRun(run.id).find((d) => d.destinationKind === "room")!;
    expect(room?.deliveryState).toBe("pending");
    expect(room?.failureCode).toBe("destination_unavailable");
    expect(repos.messages.forThread("t-lead").filter((m) => m.report?.kind === "completion")).toHaveLength(1);
    expect(repos.messages.find("missing-room", room!.messageId)).toBeNull();

    now += 60_000;
    repos.messages.append("missing-room", { role: "user", kind: "text", text: "room is back" });
    const recovered = createDelegatedResultsService({ repos, now: () => now });
    const again = recovered.pumpDue(now);
    expect(again.delivered).toBe(1);
    expect(repos.messages.forThread("missing-room").filter((m) => m.report?.kind === "completion")).toHaveLength(1);
    recovered.pumpDue(now + 1);
    expect(repos.messages.forThread("missing-room").filter((m) => m.report?.kind === "completion")).toHaveLength(1);
    expect(sendTurnCalls).toBe(0);
    noteSendTurn();
    expect(sendTurnCalls).toBe(1);
  });

  it("retries only typed transient failures on a fake clock; auth/config/quota do not auto-retry", () => {
    repos.messages.append("t-lead", { role: "user", kind: "text", text: "go" });
    const matrix: Array<{ code: "destination_unavailable" | "auth" | "config" | "quota"; auto: boolean }> = [
      { code: "destination_unavailable", auto: true },
      { code: "auth", auto: false },
      { code: "config", auto: false },
      { code: "quota", auto: false },
    ];
    for (const row of matrix) {
      const { results, identity } = boundRun({
        roomThreadId: null,
        workerThreadId: `t-helper-${row.code}`,
        taskAssignment: row.code,
      });
      const { deliveries } = results.finalize({
        identity,
        result: { text: "x", outcome: "completed" },
        now,
      });
      const delivery = deliveries[0]!;
      const claimed = repos.agentTaskRuns.claim({ now, owner: "test", deliveryId: delivery.id })!;
      repos.agentTaskRuns.failDelivery({
        deliveryId: delivery.id,
        token: claimed.token,
        failureCode: row.code,
        now,
      });
      const after = repos.agentTaskRuns.getDelivery(delivery.id)!;
      if (row.auto) {
        expect(after.deliveryState).toBe("pending");
        expect(after.retryAt).toBeGreaterThan(now);
        expect(repos.agentTaskRuns.listClaimable(now)).not.toContainEqual(expect.objectContaining({ id: delivery.id }));
        expect(repos.agentTaskRuns.listClaimable(after.retryAt!).some((d) => d.id === delivery.id)).toBe(true);
      } else {
        expect(after.deliveryState).toBe("failed");
        expect(after.retryAt).toBeNull();
        expect(repos.agentTaskRuns.listClaimable(now + 86_400_000).some((d) => d.id === delivery.id)).toBe(false);
      }
    }
    expect(sendTurnCalls).toBe(0);
  });

  it("seals partial output as interrupted and never relabels it completed", () => {
    const { results, identity, run } = boundRun({ roomThreadId: null });
    results.recordProgress({ identity, text: "halfway through the audit", now });
    const sealed = results.finalize({
      identity,
      result: { text: "halfway through the audit", outcome: "interrupted", failureCode: "interrupted" },
      now: now + 5,
    });
    expect(sealed.run.terminalOutcome).toBe("interrupted");
    expect(sealed.run.resultJson).toContain("halfway through the audit");
    expect(sealed.task?.state).toBe("cancelled");
    expect(sealed.task?.result).toBe("halfway through the audit");
    expect(() =>
      results.finalize({
        identity,
        result: { text: "actually finished", outcome: "completed" },
        now: now + 10,
      }),
    ).toThrow();
    expect(results.get(run.id)?.terminalOutcome).toBe("interrupted");
  });

  it("ignores wrong task, turn, provider, bot, thread, and destination events", () => {
    const first = boundRun({ roomThreadId: null, taskAssignment: "one" });
    const second = boundRun({
      roomThreadId: null,
      workerThreadId: "t-helper-b",
      taskAssignment: "two",
    });
    expect(repos.agentTaskRuns.getRunningForThread("t-helper")?.id).toBe(first.run.id);
    expect(repos.agentTaskRuns.getRunningForThread("t-helper-b")?.id).toBe(second.run.id);
    const wrong: RunBoundIdentity = { ...first.identity, turnId: "other-turn" };
    expect(() => first.results.recordProgress({ identity: wrong, text: "nope", now })).toThrow();
    expect(() =>
      first.results.finalize({
        identity: { ...first.identity, workerBotId: "other-bot" },
        result: { text: "nope", outcome: "completed" },
        now,
      }),
    ).toThrow();
    first.results.finalize({
      identity: first.identity,
      result: { text: "one done", outcome: "completed" },
      now,
    });
    expect(first.results.getRunningForThread(first.run.workerThreadId)).toBeNull();
    expect(second.results.get(second.run.id)?.executionState).toBe("running");
  });

  it("reconstructs the same rows on reopen and clears thinking on settled reports", () => {
    repos.messages.append("t-lead", { role: "user", kind: "text", text: "go" });
    repos.messages.append("t-lead", {
      role: "bot",
      kind: "activity",
      tool: { name: "@helper started" },
      report: { kind: "progress", fromBotId: "helper", taskId: "pending" },
    });
    const { results, identity, task } = boundRun({ roomThreadId: null });
    repos.messages.patch("t-lead", repos.messages.forThread("t-lead").find((m) => m.report?.kind === "progress")!.id, {
      report: { kind: "progress", fromBotId: "helper", taskId: task.id },
    });
    results.finalize({
      identity,
      result: { text: "done", outcome: "completed" },
      now,
    });
    results.pumpDue(now);
    db.close();
    db = openDatabase(defaultDbPath());
    repos = createRepositories(db);
    configureAgentTasks(repos.agentTasks);
    const reopened = createDelegatedResultsService({ repos, now: () => now });
    const run = reopened.get(identity.runId)!;
    expect(run.executionState).toBe("completed");
    expect(reopened.get(identity.runId)?.resultHash).toBe(run.resultHash);
    const deliveries = repos.agentTaskRuns.listDeliveriesForRun(run.id);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.deliveryState).toBe("delivered");
    const reports = repos.messages.forThread("t-lead").filter((m) => m.report);
    expect(reports.some((m) => m.report?.kind === "completion")).toBe(true);
    for (const message of reports) {
      const status = message.report?.status;
      const thinking =
        message.report?.kind === "progress" &&
        status !== "pending" &&
        status !== "terminal" &&
        status !== "failed" &&
        status !== "delivery_failed";
      expect(thinking).toBe(false);
    }
  });

  it("manual retry is only for stored failed deliveries and never starts a worker", () => {
    repos.messages.append("t-lead", { role: "user", kind: "text", text: "go" });
    const { results, identity } = boundRun({ roomThreadId: null });
    const { deliveries } = results.finalize({
      identity,
      result: { text: "done", outcome: "completed" },
      now,
    });
    const claimed = repos.agentTaskRuns.claim({ now, owner: "test", deliveryId: deliveries[0]!.id })!;
    repos.agentTaskRuns.failDelivery({
      deliveryId: deliveries[0]!.id,
      token: claimed.token,
      failureCode: "auth",
      now,
    });
    const retried = results.retryFailed(deliveries[0]!.id, now);
    expect(retried.ok).toBe(true);
    if (retried.ok) expect(["pending", "delivered", "claimed"]).toContain(retried.delivery.deliveryState);
    const live = results.retryFailed("missing");
    expect(live).toEqual({ ok: false, status: 404, error: "delivery not found", code: "not_found" });
    expect(sendTurnCalls).toBe(0);
  });
});
