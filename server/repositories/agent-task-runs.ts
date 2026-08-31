// Authoritative SQLite ledger for task-backed delegate_bot worker runs
// and their parent / optional-room destinations (#150 P0). All ledger
// writes go through this repository. Receipts are never deleted.
import { randomBytes } from "node:crypto";

import {
  canonicalJson,
  deterministicDeliveryMessageId,
  isPermanentDeliveryFailure,
  isRunFailureCode,
  isTransientDeliveryFailure,
  mapRunOutcomeToTaskPatch,
  newId,
  sha256Canonical,
  type DeliveryFailureCode,
  type RunFailureCode,
} from "../contracts.ts";
import type { SqliteDatabase } from "../db/sqlite-native.ts";
import { normalizeAgentTask, type AgentTask } from "../agent-tasks.ts";

export const RUN_EXECUTION_STATES = [
  "pending",
  "running",
  "completed",
  "failed",
  "interrupted",
  "partial",
] as const;
export type RunExecutionState = (typeof RUN_EXECUTION_STATES)[number];
export type RunTerminalOutcome = "completed" | "failed" | "interrupted" | "partial";

export const DELIVERY_STATES = ["pending", "claimed", "delivered", "failed", "rejected"] as const;
export type DeliveryState = (typeof DELIVERY_STATES)[number];
export type DeliveryDestinationKind = "parent" | "room";

export const DEFAULT_DELIVERY_MAX_ATTEMPTS = 5;
export const DEFAULT_CLAIM_LEASE_MS = 15_000;
export const MAX_CLAIM_LEASE_MS = 300_000;

export interface AgentTaskRun {
  id: string;
  taskId: string;
  workerBotId: string;
  workerThreadId: string;
  sourceBotId: string;
  sourceThreadId: string;
  parentThreadId: string;
  roomThreadId: string | null;
  attempt: number;
  executionState: RunExecutionState;
  turnId: string | null;
  providerInstanceId: string | null;
  providerModel: string | null;
  startedAt: number | null;
  createdAt: number;
  updatedAt: number;
  lastProgressAt: number | null;
  progressSeq: number;
  progressJson: string | null;
  resultJson: string | null;
  resultHash: string | null;
  terminalOutcome: RunTerminalOutcome | null;
  failureCode: RunFailureCode | null;
}

export interface AgentTaskDelivery {
  id: string;
  runId: string;
  destinationKind: DeliveryDestinationKind;
  destinationThreadId: string;
  messageId: string;
  payloadJson: string;
  payloadHash: string;
  deliveryState: DeliveryState;
  attempts: number;
  maxAttempts: number;
  retryAt: number | null;
  claimToken: string | null;
  claimOwner: string | null;
  claimLeaseExpiresAt: number | null;
  claimGeneration: number;
  failureCode: DeliveryFailureCode | null;
  deliveredAt: number | null;
  publishedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface AgentTaskDeliveryClaim {
  deliveryId: string;
  generation: number;
  token: string;
  owner: string;
  claimedAt: number;
  leaseExpiresAt: number;
  outcome: "acked" | "reclaimed" | "expired" | null;
}

export interface RunCreateInput {
  taskId: string;
  workerBotId: string;
  workerThreadId: string;
  sourceBotId: string;
  sourceThreadId: string;
  parentThreadId: string;
  roomThreadId?: string | null;
  attempt?: number;
  now?: number;
}

export interface RunBoundIdentity {
  runId: string;
  taskId: string;
  workerBotId: string;
  workerThreadId: string;
  sourceBotId: string;
  sourceThreadId: string;
  parentThreadId: string;
  roomThreadId?: string | null;
  attempt: number;
  turnId?: string | null;
  providerInstanceId?: string | null;
  providerModel?: string | null;
}

export interface SealedRunResult {
  text: string;
  outcome: RunTerminalOutcome;
  failureCode?: RunFailureCode | null;
}

export type LedgerErrorCode =
  | "identity_mismatch"
  | "conflicting_hash"
  | "illegal_transition"
  | "stale_claim"
  | "token_reused"
  | "not_found"
  | "not_claimable"
  | "not_failed"
  | "hash_mismatch"
  | "attempts_exhausted_illegal";

export class LedgerError extends Error {
  readonly code: LedgerErrorCode;
  constructor(code: LedgerErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "LedgerError";
  }
}

interface RunRow {
  id: string;
  task_id: string;
  worker_bot_id: string;
  worker_thread_id: string;
  source_bot_id: string;
  source_thread_id: string;
  parent_thread_id: string;
  room_thread_id: string | null;
  attempt: number;
  execution_state: RunExecutionState;
  turn_id: string | null;
  provider_instance_id: string | null;
  provider_model: string | null;
  started_at: number | null;
  created_at: number;
  updated_at: number;
  last_progress_at: number | null;
  progress_seq: number;
  progress_json: string | null;
  result_json: string | null;
  result_hash: string | null;
  terminal_outcome: RunTerminalOutcome | null;
  failure_code: RunFailureCode | null;
}

interface DeliveryRow {
  id: string;
  run_id: string;
  destination_kind: DeliveryDestinationKind;
  destination_thread_id: string;
  message_id: string;
  payload_json: string;
  payload_hash: string;
  delivery_state: DeliveryState;
  attempts: number;
  max_attempts: number;
  retry_at: number | null;
  claim_token: string | null;
  claim_owner: string | null;
  claim_lease_expires_at: number | null;
  claim_generation: number;
  failure_code: DeliveryFailureCode | null;
  delivered_at: number | null;
  published_at: number | null;
  created_at: number;
  updated_at: number;
}

interface ClaimRow {
  delivery_id: string;
  generation: number;
  token: string;
  owner: string;
  claimed_at: number;
  lease_expires_at: number;
  outcome: "acked" | "reclaimed" | "expired" | null;
}

interface TaskClockRow {
  id: string;
  updated_at: number;
  data: string;
}

function toRun(row: RunRow): AgentTaskRun {
  return {
    id: row.id,
    taskId: row.task_id,
    workerBotId: row.worker_bot_id,
    workerThreadId: row.worker_thread_id,
    sourceBotId: row.source_bot_id,
    sourceThreadId: row.source_thread_id,
    parentThreadId: row.parent_thread_id,
    roomThreadId: row.room_thread_id,
    attempt: row.attempt,
    executionState: row.execution_state,
    turnId: row.turn_id,
    providerInstanceId: row.provider_instance_id,
    providerModel: row.provider_model,
    startedAt: row.started_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastProgressAt: row.last_progress_at,
    progressSeq: row.progress_seq,
    progressJson: row.progress_json,
    resultJson: row.result_json,
    resultHash: row.result_hash,
    terminalOutcome: row.terminal_outcome,
    failureCode: row.failure_code,
  };
}

function toDelivery(row: DeliveryRow): AgentTaskDelivery {
  return {
    id: row.id,
    runId: row.run_id,
    destinationKind: row.destination_kind,
    destinationThreadId: row.destination_thread_id,
    messageId: row.message_id,
    payloadJson: row.payload_json,
    payloadHash: row.payload_hash,
    deliveryState: row.delivery_state,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    retryAt: row.retry_at,
    claimToken: row.claim_token,
    claimOwner: row.claim_owner,
    claimLeaseExpiresAt: row.claim_lease_expires_at,
    claimGeneration: row.claim_generation,
    failureCode: row.failure_code,
    deliveredAt: row.delivered_at,
    publishedAt: row.published_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toClaim(row: ClaimRow): AgentTaskDeliveryClaim {
  return {
    deliveryId: row.delivery_id,
    generation: row.generation,
    token: row.token,
    owner: row.owner,
    claimedAt: row.claimed_at,
    leaseExpiresAt: row.lease_expires_at,
    outcome: row.outcome,
  };
}

function identityMatches(run: AgentTaskRun, expected: RunBoundIdentity): boolean {
  if (run.id !== expected.runId) return false;
  if (run.taskId !== expected.taskId) return false;
  if (run.workerBotId !== expected.workerBotId) return false;
  if (run.workerThreadId !== expected.workerThreadId) return false;
  if (run.sourceBotId !== expected.sourceBotId) return false;
  if (run.sourceThreadId !== expected.sourceThreadId) return false;
  if (run.parentThreadId !== expected.parentThreadId) return false;
  const expectedRoom = expected.roomThreadId ?? null;
  if (run.roomThreadId !== expectedRoom) return false;
  if (run.attempt !== expected.attempt) return false;
  if (expected.turnId !== undefined && expected.turnId !== null && run.turnId !== expected.turnId) return false;
  if (
    expected.providerInstanceId !== undefined &&
    expected.providerInstanceId !== null &&
    run.providerInstanceId !== expected.providerInstanceId
  ) {
    return false;
  }
  if (expected.providerModel !== undefined && expected.providerModel !== null && run.providerModel !== expected.providerModel) {
    return false;
  }
  return true;
}

function freshClaimToken(): string {
  return randomBytes(16).toString("hex");
}

export function sealedResultBytes(result: SealedRunResult): unknown {
  return {
    failureCode: result.failureCode ?? null,
    outcome: result.outcome,
    text: result.text,
  };
}

export function deliveryBackoffMs(attempts: number): number {
  const exp = Math.min(Math.max(attempts, 1), 8);
  return Math.min(1_000 * 2 ** (exp - 1), 60_000);
}

export interface AgentTaskRunsRepository {
  createPending(input: RunCreateInput): AgentTaskRun;
  get(id: string): AgentTaskRun | null;
  getRunningForThread(workerThreadId: string): AgentTaskRun | null;
  getPendingForThread(workerThreadId: string): AgentTaskRun | null;
  listNonterminal(): AgentTaskRun[];
  listByTask(taskId: string): AgentTaskRun[];
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
    fromName?: string;
    workerName?: string;
    workerColor?: string;
  }): { run: AgentTaskRun; deliveries: AgentTaskDelivery[]; task: AgentTask | null };
  getDelivery(id: string): AgentTaskDelivery | null;
  listDeliveriesForRun(runId: string): AgentTaskDelivery[];
  listClaimable(now: number): AgentTaskDelivery[];
  listUnpublished(): AgentTaskDelivery[];
  claim(input: {
    now: number;
    owner: string;
    leaseMs?: number;
    deliveryId?: string;
  }): { delivery: AgentTaskDelivery; token: string; generation: number } | null;
  ack(input: { deliveryId: string; token: string; now: number }): AgentTaskDelivery;
  failDelivery(input: {
    deliveryId: string;
    token: string;
    failureCode: DeliveryFailureCode;
    now: number;
  }): AgentTaskDelivery;
  retryFailed(input: { deliveryId: string; now: number }): AgentTaskDelivery;
  markPublished(input: { deliveryId: string; now: number }): AgentTaskDelivery;
  listClaims(deliveryId: string): AgentTaskDeliveryClaim[];
}

const RUN_COLUMNS = `id, task_id, worker_bot_id, worker_thread_id, source_bot_id, source_thread_id,
  parent_thread_id, room_thread_id, attempt, execution_state, turn_id, provider_instance_id,
  provider_model, started_at, created_at, updated_at, last_progress_at, progress_seq, progress_json,
  result_json, result_hash, terminal_outcome, failure_code`;

const DELIVERY_COLUMNS = `id, run_id, destination_kind, destination_thread_id, message_id, payload_json,
  payload_hash, delivery_state, attempts, max_attempts, retry_at, claim_token, claim_owner,
  claim_lease_expires_at, claim_generation, failure_code, delivered_at, published_at, created_at, updated_at`;

export function createAgentTaskRunsRepository(db: SqliteDatabase): AgentTaskRunsRepository {
  const insertRun = db.prepare(`
    INSERT INTO agent_task_runs(
      id, task_id, worker_bot_id, worker_thread_id, source_bot_id, source_thread_id,
      parent_thread_id, room_thread_id, attempt, execution_state, created_at, updated_at, progress_seq
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, 0)
  `);
  const selectRun = db.prepare<RunRow>(`SELECT ${RUN_COLUMNS} FROM agent_task_runs WHERE id = ?`);
  const selectRunningThread = db.prepare<RunRow>(
    `SELECT ${RUN_COLUMNS} FROM agent_task_runs WHERE worker_thread_id = ? AND execution_state = 'running'`,
  );
  const selectPendingThread = db.prepare<RunRow>(
    `SELECT ${RUN_COLUMNS} FROM agent_task_runs WHERE worker_thread_id = ? AND execution_state = 'pending' ORDER BY created_at DESC, id DESC`,
  );
  const selectNonterminal = db.prepare<RunRow>(
    `SELECT ${RUN_COLUMNS} FROM agent_task_runs WHERE execution_state IN ('pending', 'running') ORDER BY created_at, id`,
  );
  const selectByTask = db.prepare<RunRow>(
    `SELECT ${RUN_COLUMNS} FROM agent_task_runs WHERE task_id = ? ORDER BY created_at, id`,
  );
  const bindRunningSql = db.prepare(`
    UPDATE agent_task_runs
    SET execution_state = 'running',
        turn_id = ?,
        provider_instance_id = ?,
        provider_model = ?,
        started_at = ?,
        updated_at = ?
    WHERE id = ?
      AND execution_state = 'pending'
      AND task_id = ?
      AND worker_bot_id = ?
      AND worker_thread_id = ?
      AND source_bot_id = ?
      AND source_thread_id = ?
      AND parent_thread_id = ?
      AND attempt = ?
  `);
  const progressSql = db.prepare(`
    UPDATE agent_task_runs
    SET progress_json = ?,
        progress_seq = progress_seq + 1,
        last_progress_at = ?,
        updated_at = ?
    WHERE id = ?
      AND execution_state IN ('pending', 'running')
      AND task_id = ?
      AND worker_thread_id = ?
  `);
  const terminalizeSql = db.prepare(`
    UPDATE agent_task_runs
    SET execution_state = ?,
        terminal_outcome = ?,
        result_json = ?,
        result_hash = ?,
        failure_code = ?,
        updated_at = ?
    WHERE id = ?
      AND execution_state = 'running'
      AND task_id = ?
      AND worker_bot_id = ?
      AND worker_thread_id = ?
      AND source_bot_id = ?
      AND source_thread_id = ?
      AND parent_thread_id = ?
      AND attempt = ?
      AND turn_id = ?
      AND provider_instance_id = ?
      AND provider_model = ?
  `);
  const insertDelivery = db.prepare(`
    INSERT INTO agent_task_deliveries(
      id, run_id, destination_kind, destination_thread_id, message_id, payload_json, payload_hash,
      delivery_state, attempts, max_attempts, claim_generation, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, 0, ?, ?)
  `);
  const selectDelivery = db.prepare<DeliveryRow>(`SELECT ${DELIVERY_COLUMNS} FROM agent_task_deliveries WHERE id = ?`);
  const selectDeliveriesForRun = db.prepare<DeliveryRow>(
    `SELECT ${DELIVERY_COLUMNS} FROM agent_task_deliveries WHERE run_id = ? ORDER BY destination_kind`,
  );
  const selectClaimable = db.prepare<DeliveryRow>(`
    SELECT ${DELIVERY_COLUMNS} FROM agent_task_deliveries
    WHERE (
      delivery_state = 'pending' AND (retry_at IS NULL OR retry_at <= ?)
    ) OR (
      delivery_state = 'claimed' AND claim_lease_expires_at <= ?
    )
    ORDER BY created_at, id
  `);
  const selectUnpublished = db.prepare<DeliveryRow>(`
    SELECT ${DELIVERY_COLUMNS} FROM agent_task_deliveries
    WHERE delivery_state = 'delivered' AND published_at IS NULL
    ORDER BY delivered_at, id
  `);
  const claimSql = db.prepare(`
    UPDATE agent_task_deliveries
    SET delivery_state = 'claimed',
        claim_token = ?,
        claim_owner = ?,
        claim_lease_expires_at = ?,
        claim_generation = ?,
        attempts = ?,
        retry_at = NULL,
        failure_code = NULL,
        updated_at = ?
    WHERE id = ?
      AND (
        (delivery_state = 'pending' AND (retry_at IS NULL OR retry_at <= ?))
        OR (delivery_state = 'claimed' AND claim_lease_expires_at <= ?)
      )
  `);
  const insertClaim = db.prepare(`
    INSERT INTO agent_task_delivery_claims(
      delivery_id, generation, token, owner, claimed_at, lease_expires_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  const markClaimOutcome = db.prepare(`
    UPDATE agent_task_delivery_claims SET outcome = ? WHERE delivery_id = ? AND generation = ? AND outcome IS NULL
  `);
  const ackSql = db.prepare(`
    UPDATE agent_task_deliveries
    SET delivery_state = 'delivered',
        delivered_at = ?,
        updated_at = ?,
        failure_code = NULL,
        retry_at = NULL
    WHERE id = ?
      AND delivery_state = 'claimed'
      AND claim_token = ?
      AND claim_generation = ?
  `);
  const failSql = db.prepare(`
    UPDATE agent_task_deliveries
    SET delivery_state = ?,
        failure_code = ?,
        retry_at = ?,
        claim_token = CASE WHEN ? = 'pending' THEN NULL ELSE claim_token END,
        claim_owner = CASE WHEN ? = 'pending' THEN NULL ELSE claim_owner END,
        claim_lease_expires_at = CASE WHEN ? = 'pending' THEN NULL ELSE claim_lease_expires_at END,
        updated_at = ?
    WHERE id = ?
      AND delivery_state = 'claimed'
      AND claim_token = ?
      AND claim_generation = ?
  `);
  const retryFailedSql = db.prepare(`
    UPDATE agent_task_deliveries
    SET delivery_state = 'pending',
        retry_at = ?,
        failure_code = NULL,
        claim_token = NULL,
        claim_owner = NULL,
        claim_lease_expires_at = NULL,
        updated_at = ?
    WHERE id = ?
      AND delivery_state = 'failed'
  `);
  const publishSql = db.prepare(`
    UPDATE agent_task_deliveries
    SET published_at = ?,
        updated_at = CASE WHEN updated_at > ? THEN updated_at ELSE ? END
    WHERE id = ?
      AND delivery_state = 'delivered'
      AND published_at IS NULL
  `);
  const selectClaims = db.prepare<ClaimRow>(`
    SELECT delivery_id, generation, token, owner, claimed_at, lease_expires_at, outcome
    FROM agent_task_delivery_claims
    WHERE delivery_id = ?
    ORDER BY generation
  `);
  const selectTaskClock = db.prepare<TaskClockRow>(
    "SELECT id, updated_at, data FROM agent_tasks WHERE id = ?",
  );
  const casTask = db.prepare(
    "UPDATE agent_tasks SET assignee_bot_id = ?, from_bot_id = ?, source_thread_id = ?, updated_at = ?, data = ? WHERE id = ? AND updated_at = ?",
  );

  function requireRun(id: string): AgentTaskRun {
    const row = selectRun.get(id);
    if (!row) throw new LedgerError("not_found", `run ${id} not found`);
    return toRun(row);
  }

  function requireDelivery(id: string): AgentTaskDelivery {
    const row = selectDelivery.get(id);
    if (!row) throw new LedgerError("not_found", `delivery ${id} not found`);
    return toDelivery(row);
  }

  function projectTask(
    taskId: string,
    patch: ReturnType<typeof mapRunOutcomeToTaskPatch> & {
      deliveryState: "result_stored";
      runOutcome: RunTerminalOutcome;
      failureCode?: string | null;
    },
    now: number,
  ): AgentTask | null {
    const row = selectTaskClock.get(taskId);
    if (!row) return null;
    const current = normalizeAgentTask(JSON.parse(row.data));
    if (!current) return null;
    const next = normalizeAgentTask({
      ...current,
      ...patch,
      updatedAt: now,
    });
    if (!next) return null;
    const result = casTask.run(
      next.assigneeBotId,
      next.fromBotId,
      next.sourceThreadId,
      next.updatedAt,
      JSON.stringify(next),
      taskId,
      row.updated_at,
    );
    if (result.changes !== 1) throw new LedgerError("illegal_transition", "agent_tasks updated_at CAS failed");
    return next;
  }

  const finalizeTx = db.transaction(
    (input: {
      identity: RunBoundIdentity;
      result: SealedRunResult;
      assertedHash?: string;
      now: number;
      fromName?: string;
      workerName?: string;
      workerColor?: string;
    }): { run: AgentTaskRun; deliveries: AgentTaskDelivery[]; task: AgentTask | null } => {
      const existing = requireRun(input.identity.runId);
      if (!identityMatches(existing, input.identity)) {
        throw new LedgerError("identity_mismatch", "finalize identity does not match the run");
      }
      const sealedEarly = sealedResultBytes(input.result);
      const computedHash = sha256Canonical(sealedEarly);
      if (input.assertedHash && input.assertedHash !== computedHash) {
        throw new LedgerError("hash_mismatch", "caller-asserted hash does not match canonical bytes");
      }
      if (existing.executionState !== "running") {
        if (
          existing.executionState === input.result.outcome &&
          existing.resultHash &&
          existing.resultHash === computedHash
        ) {
          return {
            run: existing,
            deliveries: selectDeliveriesForRun.all(existing.id).map(toDelivery),
            task: null,
          };
        }
        if (existing.terminalOutcome) {
          throw new LedgerError("conflicting_hash", "conflicting terminal hash");
        }
        throw new LedgerError("illegal_transition", "run is not running");
      }
      if (!existing.turnId || !existing.providerInstanceId || !existing.providerModel) {
        throw new LedgerError("illegal_transition", "running run is missing bound identity");
      }
      const sealed = sealedResultBytes(input.result);
      const hash = sha256Canonical(sealed);
      if (input.assertedHash && input.assertedHash !== hash) {
        throw new LedgerError("hash_mismatch", "caller-asserted hash does not match canonical bytes");
      }
      const failureCode =
        input.result.outcome === "completed" ? null : (input.result.failureCode ?? (input.result.outcome === "interrupted" || input.result.outcome === "partial" ? "interrupted" : "provider_error"));
      if (failureCode && !isRunFailureCode(failureCode)) {
        throw new LedgerError("illegal_transition", "terminal failure APIs accept only typed run reasons");
      }
      const resultJson = canonicalJson(sealed);
      const cas = terminalizeSql.run(
        input.result.outcome,
        input.result.outcome,
        resultJson,
        hash,
        failureCode,
        input.now,
        existing.id,
        existing.taskId,
        existing.workerBotId,
        existing.workerThreadId,
        existing.sourceBotId,
        existing.sourceThreadId,
        existing.parentThreadId,
        existing.attempt,
        existing.turnId,
        existing.providerInstanceId,
        existing.providerModel,
      );
      if (cas.changes !== 1) throw new LedgerError("illegal_transition", "terminalization CAS failed");

      const reportKind = input.result.outcome === "completed" ? "completion" : "blocker";
      const reportStatus =
        input.result.outcome === "completed" ? "terminal" : input.result.outcome === "failed" ? "failed" : "terminal";
      const payload = {
        role: "bot",
        kind: "text",
        text: input.result.text || (input.result.outcome === "completed" ? "finished" : input.result.outcome),
        report: {
          kind: reportKind,
          fromBotId: existing.workerBotId,
          taskId: existing.taskId,
          status: reportStatus,
          ...(failureCode ? { failureCode } : {}),
        },
        from: {
          botId: existing.workerBotId,
          name: input.workerName ?? existing.workerBotId,
          ...(input.workerColor ? { color: input.workerColor } : {}),
        },
        task: { id: existing.taskId },
      };
      const payloadJson = canonicalJson(payload);
      const payloadHash = sha256Canonical(payload);
      const destinations: Array<{ kind: DeliveryDestinationKind; threadId: string }> = [
        { kind: "parent", threadId: existing.parentThreadId },
      ];
      if (existing.roomThreadId) destinations.push({ kind: "room", threadId: existing.roomThreadId });
      for (const dest of destinations) {
        insertDelivery.run(
          newId(),
          existing.id,
          dest.kind,
          dest.threadId,
          deterministicDeliveryMessageId(existing.id, dest.kind),
          payloadJson,
          payloadHash,
          DEFAULT_DELIVERY_MAX_ATTEMPTS,
          input.now,
          input.now,
        );
      }
      const taskPatch = mapRunOutcomeToTaskPatch({
        outcome: input.result.outcome,
        text: input.result.text,
        failureCode,
      });
      const task = projectTask(
        existing.taskId,
        { ...taskPatch, deliveryState: "result_stored", runOutcome: input.result.outcome, failureCode },
        input.now,
      );
      return {
        run: requireRun(existing.id),
        deliveries: selectDeliveriesForRun.all(existing.id).map(toDelivery),
        task,
      };
    },
  );

  const claimTx = db.transaction(
    (input: {
      now: number;
      owner: string;
      leaseMs: number;
      deliveryId?: string;
    }): { delivery: AgentTaskDelivery; token: string; generation: number } | null => {
      const candidates = input.deliveryId
        ? [selectDelivery.get(input.deliveryId)].filter((row): row is DeliveryRow => Boolean(row))
        : selectClaimable.all(input.now, input.now);
      const row = candidates.find((candidate) => {
        if (candidate.delivery_state === "pending") {
          return candidate.retry_at === null || candidate.retry_at <= input.now;
        }
        return candidate.delivery_state === "claimed" && (candidate.claim_lease_expires_at ?? 0) <= input.now;
      });
      if (!row) return null;
      const run = selectRun.get(row.run_id);
      if (!run || !run.terminal_outcome || !run.result_hash) {
        throw new LedgerError("illegal_transition", "delivery claim requires a sealed terminal result");
      }
      const nextGeneration = row.claim_generation + 1;
      const token = freshClaimToken();
      const leaseMs = Math.min(Math.max(input.leaseMs, 1), MAX_CLAIM_LEASE_MS);
      const expires = input.now + leaseMs;
      if (row.delivery_state === "claimed" && row.claim_generation > 0) {
        markClaimOutcome.run("reclaimed", row.id, row.claim_generation);
      }
      const cas = claimSql.run(
        token,
        input.owner,
        expires,
        nextGeneration,
        row.attempts + 1,
        input.now,
        row.id,
        input.now,
        input.now,
      );
      if (cas.changes !== 1) return null;
      insertClaim.run(row.id, nextGeneration, token, input.owner, input.now, expires);
      return { delivery: requireDelivery(row.id), token, generation: nextGeneration };
    },
  );

  return {
    createPending(input) {
      const now = input.now ?? Date.now();
      const run: AgentTaskRun = {
        id: newId(),
        taskId: input.taskId,
        workerBotId: input.workerBotId,
        workerThreadId: input.workerThreadId,
        sourceBotId: input.sourceBotId,
        sourceThreadId: input.sourceThreadId,
        parentThreadId: input.parentThreadId,
        roomThreadId: input.roomThreadId ?? null,
        attempt: input.attempt ?? 1,
        executionState: "pending",
        turnId: null,
        providerInstanceId: null,
        providerModel: null,
        startedAt: null,
        createdAt: now,
        updatedAt: now,
        lastProgressAt: null,
        progressSeq: 0,
        progressJson: null,
        resultJson: null,
        resultHash: null,
        terminalOutcome: null,
        failureCode: null,
      };
      insertRun.run(
        run.id,
        run.taskId,
        run.workerBotId,
        run.workerThreadId,
        run.sourceBotId,
        run.sourceThreadId,
        run.parentThreadId,
        run.roomThreadId,
        run.attempt,
        run.createdAt,
        run.updatedAt,
      );
      return run;
    },
    get(id) {
      const row = selectRun.get(id);
      return row ? toRun(row) : null;
    },
    getRunningForThread(workerThreadId) {
      const row = selectRunningThread.get(workerThreadId);
      return row ? toRun(row) : null;
    },
    getPendingForThread(workerThreadId) {
      const row = selectPendingThread.get(workerThreadId);
      return row ? toRun(row) : null;
    },
    listNonterminal() {
      return selectNonterminal.all().map(toRun);
    },
    listByTask(taskId) {
      return selectByTask.all(taskId).map(toRun);
    },
    bindRunning(input) {
      const existing = requireRun(input.identity.runId);
      if (!identityMatches(existing, input.identity)) {
        throw new LedgerError("identity_mismatch", "bind identity does not match the run");
      }
      const cas = bindRunningSql.run(
        input.turnId,
        input.providerInstanceId,
        input.providerModel,
        input.startedAt,
        input.startedAt,
        existing.id,
        existing.taskId,
        existing.workerBotId,
        existing.workerThreadId,
        existing.sourceBotId,
        existing.sourceThreadId,
        existing.parentThreadId,
        existing.attempt,
      );
      if (cas.changes !== 1) throw new LedgerError("illegal_transition", "bind running CAS failed");
      return requireRun(existing.id);
    },
    recordProgress(input) {
      const existing = requireRun(input.identity.runId);
      if (!identityMatches(existing, input.identity)) {
        throw new LedgerError("identity_mismatch", "progress identity does not match the run");
      }
      const cas = progressSql.run(
        canonicalJson({ text: input.text }),
        input.now,
        input.now,
        existing.id,
        existing.taskId,
        existing.workerThreadId,
      );
      if (cas.changes !== 1) throw new LedgerError("illegal_transition", "progress CAS failed");
      return requireRun(existing.id);
    },
    finalize(input) {
      return finalizeTx(input);
    },
    getDelivery(id) {
      const row = selectDelivery.get(id);
      return row ? toDelivery(row) : null;
    },
    listDeliveriesForRun(runId) {
      return selectDeliveriesForRun.all(runId).map(toDelivery);
    },
    listClaimable(now) {
      return selectClaimable.all(now, now).map(toDelivery);
    },
    listUnpublished() {
      return selectUnpublished.all().map(toDelivery);
    },
    claim(input) {
      return claimTx({
        now: input.now,
        owner: input.owner,
        leaseMs: input.leaseMs ?? DEFAULT_CLAIM_LEASE_MS,
        deliveryId: input.deliveryId,
      });
    },
    ack(input) {
      const delivery = requireDelivery(input.deliveryId);
      if (delivery.deliveryState === "delivered" && delivery.claimToken === input.token) {
        return delivery;
      }
      const used = selectClaims
        .all(input.deliveryId)
        .some((row) => row.token === input.token && row.generation !== delivery.claimGeneration);
      if (used) throw new LedgerError("token_reused", "claim token is not reusable after reclaim");
      if (delivery.deliveryState !== "claimed" || delivery.claimToken !== input.token) {
        throw new LedgerError("stale_claim", "stale claim token rejected");
      }
      const cas = ackSql.run(
        input.now,
        input.now,
        delivery.id,
        input.token,
        delivery.claimGeneration,
      );
      if (cas.changes !== 1) throw new LedgerError("stale_claim", "ack CAS failed");
      markClaimOutcome.run("acked", delivery.id, delivery.claimGeneration);
      return requireDelivery(delivery.id);
    },
    failDelivery(input) {
      const delivery = requireDelivery(input.deliveryId);
      if (delivery.deliveryState !== "claimed" || delivery.claimToken !== input.token) {
        throw new LedgerError("stale_claim", "fail requires the fresh claim token");
      }
      if (input.failureCode === "attempts_exhausted" && delivery.attempts < delivery.maxAttempts) {
        throw new LedgerError("attempts_exhausted_illegal", "attempts_exhausted is legal only at the limit");
      }
      const exhausted = delivery.attempts >= delivery.maxAttempts;
      const permanent = isPermanentDeliveryFailure(input.failureCode) || input.failureCode === "attempts_exhausted";
      const nextState = permanent || exhausted ? "failed" : "pending";
      const code: DeliveryFailureCode = exhausted && isTransientDeliveryFailure(input.failureCode)
        ? "attempts_exhausted"
        : input.failureCode;
      const retryAt = nextState === "pending" ? input.now + deliveryBackoffMs(delivery.attempts) : null;
      const cas = failSql.run(
        nextState,
        code,
        retryAt,
        nextState,
        nextState,
        nextState,
        input.now,
        delivery.id,
        input.token,
        delivery.claimGeneration,
      );
      if (cas.changes !== 1) throw new LedgerError("stale_claim", "fail CAS failed");
      return requireDelivery(delivery.id);
    },
    retryFailed(input) {
      const delivery = requireDelivery(input.deliveryId);
      if (delivery.deliveryState !== "failed") {
        throw new LedgerError("not_failed", "manual retry is only for stored failed deliveries");
      }
      const cas = retryFailedSql.run(input.now, input.now, delivery.id);
      if (cas.changes !== 1) throw new LedgerError("not_failed", "manual retry CAS failed");
      return requireDelivery(delivery.id);
    },
    markPublished(input) {
      publishSql.run(input.now, input.now, input.now, input.deliveryId);
      return requireDelivery(input.deliveryId);
    },
    listClaims(deliveryId) {
      return selectClaims.all(deliveryId).map(toClaim);
    },
  };
}
