// #150 P0 ledger: migration 23, CAS, claims, hashes, and fail-closed SQL.
import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createAgentTask, configureAgentTasks } from "../agent-tasks.ts";
import { DATA_DIR } from "../config.ts";
import { sha256Canonical } from "../contracts.ts";
import { defaultDbPath, openDatabase } from "../db/database.ts";
import { MIGRATIONS } from "../db/migrations.ts";
import type { SqliteDatabase } from "../db/sqlite-native.ts";
import { createRepositories, type Repositories } from "./index.ts";
import {
  LedgerError,
  deliveryBackoffMs,
  sealedResultBytes,
  type RunBoundIdentity,
} from "./agent-task-runs.ts";

const V22_NAMES = MIGRATIONS.filter((m) => m.version <= 22).map((m) => m.name);

describe("agent task result ledger", () => {
  let db: SqliteDatabase;
  let repos: Repositories;

  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    db = openDatabase(defaultDbPath());
    repos = createRepositories(db);
    configureAgentTasks(repos.agentTasks);
  });

  afterEach(() => {
    configureAgentTasks(null);
    try {
      db.close();
    } catch {
      /* already closed */
    }
  });

  function seedTask() {
    return createAgentTask({
      assigneeBotId: "helper",
      fromBotId: "lead",
      fromName: "Lead",
      sourceThreadId: "t-lead",
      assignment: "audit the repo",
      now: 1_000,
    });
  }

  function createBound(now = 2_000) {
    const task = seedTask();
    const run = repos.agentTaskRuns.createPending({
      taskId: task.id,
      workerBotId: "helper",
      workerThreadId: "t-helper",
      sourceBotId: "lead",
      sourceThreadId: "t-lead",
      parentThreadId: "t-lead",
      roomThreadId: "t-room",
      now: 1_000,
    });
    const identity: RunBoundIdentity = {
      runId: run.id,
      taskId: task.id,
      workerBotId: "helper",
      workerThreadId: "t-helper",
      sourceBotId: "lead",
      sourceThreadId: "t-lead",
      parentThreadId: "t-lead",
      roomThreadId: "t-room",
      attempt: 1,
    };
    const bound = repos.agentTaskRuns.bindRunning({
      identity,
      turnId: `turn-${run.id}`,
      providerInstanceId: "fake",
      providerModel: "fake-1",
      startedAt: now,
    });
    return { task, run: bound, identity: { ...identity, turnId: bound.turnId, providerInstanceId: "fake", providerModel: "fake-1" } };
  }

  it("appends migration 23 without a down migration and leaves v1–22 names intact", () => {
    expect(V22_NAMES.at(-1)).toBe("request-lineage-and-usage");
    expect(MIGRATIONS.map((m) => m.version)).toEqual([...Array(23)].map((_, i) => i + 1));
    expect(MIGRATIONS.every((m) => !("down" in m))).toBe(true);
    expect(MIGRATIONS[22]?.name).toBe("agent-task-result-ledger");
  });

  it("rejects raw INSERT OR REPLACE on every PK and unique surface", () => {
    const { run } = createBound();
    const finalized = repos.agentTaskRuns.finalize({
      identity: {
        runId: run.id,
        taskId: run.taskId,
        workerBotId: run.workerBotId,
        workerThreadId: run.workerThreadId,
        sourceBotId: run.sourceBotId,
        sourceThreadId: run.sourceThreadId,
        parentThreadId: run.parentThreadId,
        roomThreadId: run.roomThreadId,
        attempt: 1,
        turnId: run.turnId,
        providerInstanceId: run.providerInstanceId,
        providerModel: run.providerModel,
      },
      result: { text: "done", outcome: "completed" },
      now: 3_000,
    });
    const delivery = finalized.deliveries[0]!;
    expect(() =>
      db.prepare(
        `INSERT OR REPLACE INTO agent_task_runs(
          id, task_id, worker_bot_id, worker_thread_id, source_bot_id, source_thread_id,
          parent_thread_id, attempt, execution_state, created_at, updated_at, progress_seq
        ) VALUES (?, 'attacker', 'x', 'y', 'z', 's', 'p', 9, 'pending', 1, 1, 0)`,
      ).run(run.id),
    ).toThrow(/cannot be replaced|cannot be deleted|insert must be pending/);
    expect(() =>
      db.prepare(
        `INSERT OR REPLACE INTO agent_task_deliveries(
          id, run_id, destination_kind, destination_thread_id, message_id, payload_json, payload_hash,
          delivery_state, created_at, updated_at
        ) VALUES (?, ?, 'parent', 'stolen', 'stolen-msg', '{}', ?, 'pending', 1, 1)`,
      ).run(delivery.id, run.id, "a".repeat(64)),
    ).toThrow(/cannot be replaced|cannot be deleted|insert must be pending/);
    const claim = repos.agentTaskRuns.claim({ now: 4_000, owner: "a", deliveryId: delivery.id })!;
    expect(() =>
      db.prepare(
        `INSERT OR REPLACE INTO agent_task_delivery_claims(
          delivery_id, generation, token, owner, claimed_at, lease_expires_at
        ) VALUES (?, ?, ?, 'thief', 1, 2)`,
      ).run(delivery.id, claim.generation, claim.token),
    ).toThrow(/cannot be replaced|cannot be deleted/);
    expect(repos.agentTaskRuns.get(run.id)?.taskId).toBe(run.taskId);
    expect(repos.agentTaskRuns.get(run.id)?.executionState).toBe("completed");
  });

  it("cannot jump pending to completed and running requires bound identity", () => {
    const task = seedTask();
    const run = repos.agentTaskRuns.createPending({
      taskId: task.id,
      workerBotId: "helper",
      workerThreadId: "t-helper",
      sourceBotId: "lead",
      sourceThreadId: "t-lead",
      parentThreadId: "t-lead",
      now: 1_000,
    });
    expect(() =>
      db.prepare("UPDATE agent_task_runs SET execution_state = 'completed', terminal_outcome = 'completed' WHERE id = ?").run(run.id),
    ).toThrow(/illegal state transition|CHECK/);
    expect(() =>
      db.prepare(
        `INSERT INTO agent_task_runs(
          id, task_id, worker_bot_id, worker_thread_id, source_bot_id, source_thread_id,
          parent_thread_id, attempt, execution_state, created_at, updated_at, progress_seq
        ) VALUES ('r-run', ?, 'helper', 't-helper-2', 'lead', 't-lead', 't-lead', 1, 'running', 1, 1, 0)`,
      ).run(task.id),
    ).toThrow(/insert must be pending|CHECK/);
    expect(() =>
      repos.agentTaskRuns.bindRunning({
        identity: {
          runId: run.id,
          taskId: task.id,
          workerBotId: "helper",
          workerThreadId: "t-helper",
          sourceBotId: "lead",
          sourceThreadId: "t-lead",
          parentThreadId: "t-lead",
          attempt: 1,
        },
        turnId: "",
        providerInstanceId: "fake",
        providerModel: "fake-1",
        startedAt: 2_000,
      }),
    ).toThrow();
  });

  it("terminalizes once by CAS; identical duplicate is a no-op; conflicting hash fails closed", () => {
    const { run, identity } = createBound();
    const first = repos.agentTaskRuns.finalize({
      identity,
      result: { text: "audit complete", outcome: "completed" },
      now: 3_000,
    });
    expect(first.run.executionState).toBe("completed");
    expect(first.run.resultHash).toBe(sha256Canonical(sealedResultBytes({ text: "audit complete", outcome: "completed" })));
    const dup = repos.agentTaskRuns.finalize({
      identity,
      result: { text: "audit complete", outcome: "completed" },
      now: 4_000,
    });
    expect(dup.run.updatedAt).toBe(first.run.updatedAt);
    expect(dup.deliveries).toHaveLength(first.deliveries.length);
    expect(() =>
      repos.agentTaskRuns.finalize({
        identity,
        result: { text: "different", outcome: "completed" },
        now: 5_000,
      }),
    ).toThrow(LedgerError);
    expect(() =>
      repos.agentTaskRuns.finalize({
        identity,
        result: { text: "audit complete", outcome: "completed" },
        assertedHash: "b".repeat(64),
        now: 5_000,
      }),
    ).toThrow(/hash/);
    expect(repos.agentTaskRuns.get(run.id)?.resultJson).toBe(first.run.resultJson);
  });

  it("claims with a fresh token, rejects stale ack, and cannot reuse a token after reclaim", () => {
    const { identity } = createBound();
    db.prepare("INSERT INTO threads(id, bot_id, created_at) VALUES (?, NULL, ?)").run("t-lead", 1);
    const { deliveries } = repos.agentTaskRuns.finalize({
      identity,
      result: { text: "done", outcome: "completed" },
      now: 3_000,
    });
    const parent = deliveries.find((row) => row.destinationKind === "parent")!;
    const first = repos.agentTaskRuns.claim({ now: 4_000, owner: "pump-a", deliveryId: parent.id, leaseMs: 1_000 })!;
    const second = repos.agentTaskRuns.claim({ now: 4_000, owner: "pump-b", deliveryId: parent.id, leaseMs: 1_000 });
    expect(second).toBeNull();
    const reclaimed = repos.agentTaskRuns.claim({ now: 5_100, owner: "pump-b", deliveryId: parent.id, leaseMs: 1_000 })!;
    expect(reclaimed.generation).toBe(first.generation + 1);
    expect(reclaimed.token).not.toBe(first.token);
    expect(() => repos.agentTaskRuns.ack({ deliveryId: parent.id, token: first.token, now: 5_200 })).toThrow(/stale|reused|reclaim/);
    repos.messages.putFixed("t-lead", parent.messageId, JSON.parse(parent.payloadJson));
    const acked = repos.agentTaskRuns.ack({ deliveryId: parent.id, token: reclaimed.token, now: 5_200 });
    expect(acked.deliveryState).toBe("delivered");
    const again = repos.agentTaskRuns.ack({ deliveryId: parent.id, token: reclaimed.token, now: 5_300 });
    expect(again.deliveredAt).toBe(acked.deliveredAt);
    expect(() => repos.agentTaskRuns.ack({ deliveryId: parent.id, token: first.token, now: 5_400 })).toThrow(/reused|stale|reclaim/);
  });

  it("retains run and delivery receipts after bot deletion", () => {
    const { identity, task } = createBound();
    db.prepare("INSERT INTO threads(id, bot_id, created_at) VALUES (?, NULL, ?)").run("t-lead", 1);
    const sealed = repos.agentTaskRuns.finalize({
      identity,
      result: { text: "kept", outcome: "failed", failureCode: "provider_error" },
      now: 3_000,
    });
    const before = {
      run: repos.agentTaskRuns.get(identity.runId),
      deliveries: repos.agentTaskRuns.listDeliveriesForRun(identity.runId),
    };
    expect(repos.agentTasks.deleteForBot("helper")).toBeGreaterThan(0);
    expect(repos.agentTasks.get(task.id)).toBeNull();
    expect(repos.agentTaskRuns.get(identity.runId)).toEqual(before.run);
    expect(repos.agentTaskRuns.listDeliveriesForRun(identity.runId)).toEqual(before.deliveries);
    expect(sealed.run.failureCode).toBe("provider_error");
  });

  it("uses the observed agent_tasks updated_at CAS clock in the terminal+outbox transaction", () => {
    const { identity, task } = createBound();
    const projected = repos.agentTaskRuns.finalize({
      identity,
      result: { text: "audit complete", outcome: "completed" },
      now: 9_000,
    });
    expect(projected.task?.state).toBe("completed");
    expect(projected.task?.result).toBe("audit complete");
    expect(projected.task?.updatedAt).toBe(9_000);
    expect(projected.task?.deliveryState).toBe("result_stored");
    expect(repos.agentTasks.get(task.id)?.updatedAt).toBe(9_000);
    expect(projected.deliveries.length).toBe(2);
  });

  it("maps typed run outcomes without parsing provider prose", () => {
    const cases = [
      { outcome: "interrupted" as const, failureCode: "interrupted" as const, state: "cancelled" },
      { outcome: "partial" as const, failureCode: "interrupted" as const, state: "cancelled" },
      { outcome: "failed" as const, failureCode: "quota" as const, state: "blocked" },
    ];
    for (const [index, row] of cases.entries()) {
      const task = createAgentTask({
        assigneeBotId: `helper-${index}`,
        fromBotId: "lead",
        fromName: "Lead",
        sourceThreadId: "t-lead",
        assignment: `job ${index}`,
        now: 1_000 + index,
      });
      const run = repos.agentTaskRuns.createPending({
        taskId: task.id,
        workerBotId: `helper-${index}`,
        workerThreadId: `t-helper-${index}`,
        sourceBotId: "lead",
        sourceThreadId: "t-lead",
        parentThreadId: "t-lead",
        now: 1_000,
      });
      const bound = repos.agentTaskRuns.bindRunning({
        identity: {
          runId: run.id,
          taskId: task.id,
          workerBotId: `helper-${index}`,
          workerThreadId: `t-helper-${index}`,
          sourceBotId: "lead",
          sourceThreadId: "t-lead",
          parentThreadId: "t-lead",
          attempt: 1,
        },
        turnId: `turn-${index}`,
        providerInstanceId: "fake",
        providerModel: "fake-1",
        startedAt: 2_000,
      });
      const out = repos.agentTaskRuns.finalize({
        identity: {
          runId: bound.id,
          taskId: task.id,
          workerBotId: bound.workerBotId,
          workerThreadId: bound.workerThreadId,
          sourceBotId: "lead",
          sourceThreadId: "t-lead",
          parentThreadId: "t-lead",
          attempt: 1,
          turnId: bound.turnId,
          providerInstanceId: "fake",
          providerModel: "fake-1",
        },
        result: { text: "partial notes", outcome: row.outcome, failureCode: row.failureCode },
        now: 3_000,
      });
      expect(out.task?.state).toBe(row.state);
      expect(out.run.terminalOutcome).toBe(row.outcome);
      expect(out.run.terminalOutcome).not.toBe("completed");
    }
    expect(deliveryBackoffMs(1)).toBe(1_000);
    expect(deliveryBackoffMs(3)).toBe(4_000);
  });
});
