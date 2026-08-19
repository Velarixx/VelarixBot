// Routine repository: CRUD, schedule round-trips, and the durable
// routine_runs ledger (claims with idempotency keys, leases, attempts,
// skips, pruning, boot recovery).
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "../config.ts";
import { defaultDbPath, openDatabase } from "../db/database.ts";
import type { SqliteDatabase } from "../db/sqlite-native.ts";
import { IdentitySessions } from "../identity.ts";
import { zeroUsage, type BotRecord, type RoutineRecord } from "../store.ts";
import { createBotsRepository } from "./bots.ts";
import { createComputerBindingsRepository } from "./computer-bindings.ts";
import { createRoutinesRepository, RUN_HISTORY_KEEP, type ClaimRunInput } from "./routines.ts";

function makeBot(overrides: Partial<BotRecord> = {}): BotRecord {
  const id = overrides.id ?? `bot-${Math.random().toString(36).slice(2)}`;
  return {
    id,
    threadId: overrides.threadId ?? `thread-${id}`,
    name: "Testy",
    title: "",
    description: "",
    notifications: true,
    color: "blue",
    iconShape: "cursor",
    unread: false,
    modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
    resumeCursors: {},
    computer: "off",
    busy: false,
    state: "IDLE",
    usage: zeroUsage(),
    createdAt: Date.now(),
    ...overrides,
  };
}

function makeRoutine(overrides: Partial<RoutineRecord> = {}): RoutineRecord {
  const id = overrides.id ?? `routine-${Math.random().toString(36).slice(2)}`;
  return {
    id,
    botId: "bot-1",
    name: "Check inbox",
    prompt: "Check inbox",
    schedule: { kind: "interval", everyMinutes: 15 },
    enabled: true,
    running: false,
    nextRunAt: Date.now() + 60_000,
    lastRunAt: null,
    lastResult: null,
    createdAt: Date.now(),
    missedPolicy: "run-once",
    ...overrides,
  };
}

function claimInput(overrides: Partial<ClaimRunInput> = {}): ClaimRunInput {
  return {
    routineId: "routine-1",
    botId: "bot-1",
    startedAt: 1_000,
    leaseUntil: 61_000,
    kind: "scheduled",
    scheduledFor: 1_000,
    idempotencyKey: "routine-1@1000",
    ...overrides,
  };
}

describe("routines repository", () => {
  let db: SqliteDatabase;
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    db = openDatabase(defaultDbPath());
  });
  afterEach(() => {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  });

  it("round-trips schedules and metadata across reopen", () => {
    const routines = createRoutinesRepository(db);
    const daily = makeRoutine({ schedule: { kind: "daily", time: "09:30" } });
    const listener = makeRoutine({
      schedule: {
        kind: "listener",
        source: "github",
        everyMinutes: 15,
        repo: { owner: "Velarixx", name: "VelarixBot" },
        events: ["pull_request"],
      },
      listenerCursor: "42",
    });
    routines.insert(daily);
    routines.insert(listener);
    routines.update({ ...daily, enabled: false, lastRunAt: 123, lastResult: "done" });
    db.close();
    db = openDatabase(defaultDbPath());
    const reloaded = createRoutinesRepository(db);
    expect(reloaded.get(daily.id)).toMatchObject({ schedule: { kind: "daily", time: "09:30" }, enabled: false, lastRunAt: 123, lastResult: "done" });
    expect(reloaded.get(listener.id)?.schedule).toEqual({
      kind: "listener",
      source: "github",
      everyMinutes: 15,
      repo: { owner: "Velarixx", name: "VelarixBot" },
      events: ["pull_request"],
    });
    expect(reloaded.get(listener.id)?.listenerCursor).toBe("42");
    expect(reloaded.list().map((r) => r.id)).toEqual([daily.id, listener.id]);
    expect(reloaded.delete(daily.id)).toBe(true);
    expect(reloaded.delete(daily.id)).toBe(false);
  });

  it("claims, finishes, and lists runs newest-first", () => {
    const routines = createRoutinesRepository(db);
    const routine = makeRoutine({ id: "routine-1" });
    routines.insert(routine);
    const first = routines.claimRun(claimInput());
    expect(first).toMatchObject({ attempt: 1 });
    routines.finishRun(first!.seq, "done", "DONE", 2_000);
    const second = routines.claimRun(claimInput({ startedAt: 3_000, scheduledFor: 3_000, idempotencyKey: "routine-1@3000", leaseUntil: 63_000 }));
    routines.finishRun(second!.seq, "blocked", "BLOCKED: failed", 4_000);
    const runs = routines.runsFor("routine-1");
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({ started_at: 3_000, finished_at: 4_000, result: "BLOCKED: failed", status: "blocked", kind: "scheduled" });
    expect(runs[1]).toMatchObject({ started_at: 1_000, finished_at: 2_000, result: "DONE", status: "done", scheduled_for: 1_000 });
    // finishing an already-finished run is a no-op, never a crash
    routines.finishRun(second!.seq, "done", "late", 5_000);
    expect(routines.runsFor("routine-1")[0].result).toBe("BLOCKED: failed");
  });

  it("idempotency key: one occurrence never produces two runs", () => {
    const routines = createRoutinesRepository(db);
    routines.insert(makeRoutine({ id: "routine-1" }));
    const first = routines.claimRun(claimInput());
    expect(first).not.toBeNull();
    // live lease → refuse
    expect(routines.claimRun(claimInput({ startedAt: 2_000 }))).toBeNull();
    // finished → refuse forever (the occurrence already ran)
    routines.finishRun(first!.seq, "done", "DONE", 3_000);
    expect(routines.claimRun(claimInput({ startedAt: 100_000, leaseUntil: 160_000 }))).toBeNull();
    expect(routines.runsFor("routine-1")).toHaveLength(1);
  });

  it("lease recovery: an expired-lease run is taken over in place as attempt 2", () => {
    const routines = createRoutinesRepository(db);
    routines.insert(makeRoutine({ id: "routine-1" }));
    const first = routines.claimRun(claimInput({ leaseUntil: 61_000 }));
    expect(first).toMatchObject({ attempt: 1 });
    // lease lapsed (the owning process died): the same occurrence is
    // reclaimed in place — same row, attempt 2, still exactly one run
    const takeover = routines.claimRun(claimInput({ startedAt: 61_001, leaseUntil: 121_001 }));
    expect(takeover).toEqual({ seq: first!.seq, attempt: 2 });
    expect(routines.runsFor("routine-1")).toHaveLength(1);
    expect(routines.runsFor("routine-1")[0]).toMatchObject({ attempt: 2, status: "running", started_at: 61_001 });
  });

  it("manual runs carry no idempotency key and stack freely", () => {
    const routines = createRoutinesRepository(db);
    routines.insert(makeRoutine({ id: "routine-1" }));
    const a = routines.claimRun(claimInput({ kind: "manual", scheduledFor: null, idempotencyKey: null }));
    routines.finishRun(a!.seq, "done", "DONE", 2_000);
    const b = routines.claimRun(claimInput({ kind: "manual", scheduledFor: null, idempotencyKey: null, startedAt: 3_000 }));
    expect(b).not.toBeNull();
    expect(routines.runsFor("routine-1")).toHaveLength(2);
    expect(routines.runsFor("routine-1")[0].kind).toBe("manual");
  });

  it("records skips with a reason, once per occurrence", () => {
    const routines = createRoutinesRepository(db);
    routines.insert(makeRoutine({ id: "routine-1" }));
    expect(
      routines.recordSkip({ routineId: "routine-1", botId: "bot-1", at: 5_000, scheduledFor: 1_000, idempotencyKey: "routine-1@1000", reason: "skipped: bot busy" }),
    ).toBe(true);
    expect(
      routines.recordSkip({ routineId: "routine-1", botId: "bot-1", at: 6_000, scheduledFor: 1_000, idempotencyKey: "routine-1@1000", reason: "skipped: bot busy" }),
    ).toBe(false);
    const runs = routines.runsFor("routine-1");
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "skipped", result: "skipped: bot busy", scheduled_for: 1_000, finished_at: 5_000 });
    // a skipped occurrence is settled: the key can never be claimed later
    expect(routines.claimRun(claimInput())).toBeNull();
  });

  it("expires lapsed leases and recovers interrupted runs at boot", () => {
    const routines = createRoutinesRepository(db);
    const scheduler = routines.internalScheduler;
    routines.insert(makeRoutine({ id: "routine-1", running: true }));
    const run = scheduler.claimRun(claimInput({ leaseUntil: 61_000 }));
    expect(scheduler.expiredRuns(60_999)).toEqual([]);
    expect(scheduler.expiredRuns(61_000).map((r) => r.seq)).toEqual([run!.seq]);
    scheduler.renewLeases([run!.seq], 200_000);
    expect(scheduler.expiredRuns(61_000)).toEqual([]);
    // boot: single process, so every running row is orphaned
    expect(scheduler.recoverInterrupted(70_000)).toBe(1);
    expect(routines.runsFor("routine-1")[0]).toMatchObject({
      status: "interrupted",
      finished_at: 70_000,
      result: "interrupted: VelarixBot quit mid-run",
    });
    expect(routines.get("routine-1")?.running).toBe(false);
    expect(scheduler.recoverInterrupted(80_000)).toBe(0);
  });

  it("prunes history to the newest 20 rows per routine", () => {
    const routines = createRoutinesRepository(db);
    routines.insert(makeRoutine({ id: "routine-1" }));
    routines.insert(makeRoutine({ id: "routine-2" }));
    for (let i = 0; i < RUN_HISTORY_KEEP + 5; i++) {
      const run = routines.claimRun(claimInput({ startedAt: i * 1_000, scheduledFor: i * 1_000, idempotencyKey: `routine-1@${i * 1000}`, leaseUntil: i * 1_000 + 60_000 }));
      routines.finishRun(run!.seq, "done", "DONE", i * 1_000 + 1);
    }
    routines.claimRun(claimInput({ routineId: "routine-2", idempotencyKey: "routine-2@1000" }));
    const runs = routines.runsFor("routine-1");
    expect(runs).toHaveLength(RUN_HISTORY_KEEP);
    expect(runs[0].started_at).toBe((RUN_HISTORY_KEEP + 4) * 1_000);
    expect(runs.at(-1)!.started_at).toBe(5_000);
    expect(routines.runsFor("routine-2")).toHaveLength(1);
  });

  it("deleting a routine drops its run history too", () => {
    const routines = createRoutinesRepository(db);
    routines.insert(makeRoutine({ id: "routine-1" }));
    routines.claimRun(claimInput());
    expect(routines.delete("routine-1")).toBe(true);
    expect(routines.runsFor("routine-1")).toEqual([]);
  });

  it("deleteForBot removes the bot's routines and run history", () => {
    const routines = createRoutinesRepository(db);
    routines.insert(makeRoutine({ id: "keep", botId: "other" }));
    routines.insert(makeRoutine({ id: "drop-1" }));
    routines.insert(makeRoutine({ id: "drop-2" }));
    routines.claimRun(claimInput({ routineId: "drop-1", idempotencyKey: "drop-1@1000" }));
    expect(routines.deleteForBot("bot-1").sort()).toEqual(["drop-1", "drop-2"]);
    expect(routines.list().map((r) => r.id)).toEqual(["keep"]);
    expect(routines.runsFor("drop-1")).toEqual([]);
  });

  it("isolates tenant CRUD, claims, finishes, lease renewal, and history from exact foreign identifiers", () => {
    const identity = new IdentitySessions(db);
    const userA = identity.upsertGithubIdentity({ githubId: 401, login: "routine-a" }, 1_000);
    const userB = identity.upsertGithubIdentity({ githubId: 402, login: "routine-b" }, 1_000);
    const bots = createBotsRepository(db);
    const legacyBot = makeBot({ id: "legacy-bot" });
    const botA = makeBot({ id: "bot-a" });
    const botB = makeBot({ id: "bot-b" });
    bots.insert(legacyBot);
    bots.forOwner(userA.id).insert(botA);
    bots.forOwner(userB.id).insert(botB);

    const routines = createRoutinesRepository(db);
    const legacy = makeRoutine({ id: "legacy-routine", botId: legacyBot.id });
    const routineA = makeRoutine({ id: "routine-a", botId: botA.id });
    const routineB = makeRoutine({ id: "routine-b", botId: botB.id });
    routines.insert(legacy);
    routines.forOwner(userA.id).insert(routineA);
    routines.forOwner(userB.id).insert(routineB);
    const legacyRun = routines.claimRun(
      claimInput({ routineId: legacy.id, botId: legacyBot.id, idempotencyKey: "legacy-routine@1000" }),
    );

    const tenantA = routines.forOwner(userA.id);
    const tenantB = routines.forOwner(userB.id);
    expect("internalScheduler" in tenantA).toBe(false);
    expect(tenantA.list().map((routine) => routine.id)).toEqual([routineA.id]);
    expect(tenantA.get(routineB.id)).toBeNull();
    expect(tenantA.get(legacy.id)).toBeNull();
    expect(tenantA.update({ ...routineB, name: "cross-tenant" })).toBe(false);
    expect(tenantA.update({ ...legacy, name: "claimed legacy" })).toBe(false);
    expect(tenantB.get(routineB.id)?.name).toBe("Check inbox");

    const runB = tenantB.claimRun(
      claimInput({ routineId: routineB.id, botId: botB.id, idempotencyKey: "routine-b@1000" }),
    );
    expect(runB).not.toBeNull();
    expect(
      tenantA.claimRun(claimInput({ routineId: routineB.id, botId: botB.id, idempotencyKey: "routine-b@1000" })),
    ).toBeNull();
    expect(
      tenantA.claimRun(claimInput({ routineId: legacy.id, botId: legacyBot.id, idempotencyKey: "legacy-routine@1000" })),
    ).toBeNull();
    expect(
      tenantA.claimRun(claimInput({ routineId: routineA.id, botId: botA.id, idempotencyKey: "routine-b@1000" })),
    ).toBeNull();
    expect(
      tenantA.recordSkip({
        routineId: routineB.id,
        botId: botB.id,
        at: 2_000,
        reason: "cross-tenant skip",
        idempotencyKey: "routine-b-skip@2000",
      }),
    ).toBe(false);
    expect(tenantA.finishRun(runB!.seq, "done", "stolen", 2_000)).toBe(false);
    expect(tenantA.finishRun(legacyRun!.seq, "done", "claimed legacy", 2_000)).toBe(false);
    expect(tenantA.renewLeases([runB!.seq], 120_000)).toBe(0);
    expect(tenantA.runsFor(routineB.id)).toEqual([]);
    expect(tenantA.runsFor(legacy.id)).toEqual([]);
    expect(tenantB.runsFor(routineB.id)[0]).toMatchObject({ status: "running", lease_until: 61_000 });
    expect(tenantB.finishRun(runB!.seq, "done", "DONE", 3_000)).toBe(true);

    const runA = tenantA.claimRun(
      claimInput({ routineId: routineA.id, botId: botA.id, idempotencyKey: "routine-a@1000" }),
    );
    expect(runA).not.toBeNull();
    expect(tenantA.finishRun(runA!.seq, "done", "DONE", 3_000)).toBe(true);
    expect(tenantA.runsFor(routineA.id)).toHaveLength(1);
    expect(tenantA.delete(routineB.id)).toBe(false);
    expect(tenantA.delete(legacy.id)).toBe(false);
    expect(tenantB.get(routineB.id)).not.toBeNull();
  });

  it("creates only for an owned existing bot and rolls back invalid targets and id collisions", () => {
    const identity = new IdentitySessions(db);
    const userA = identity.upsertGithubIdentity({ githubId: 501, login: "create-a" }, 1_000);
    const userB = identity.upsertGithubIdentity({ githubId: 502, login: "create-b" }, 1_000);
    const bots = createBotsRepository(db);
    const legacyBot = makeBot({ id: "legacy-bot" });
    const botA = makeBot({ id: "bot-a" });
    const botB = makeBot({ id: "bot-b" });
    bots.insert(legacyBot);
    bots.forOwner(userA.id).insert(botA);
    bots.forOwner(userB.id).insert(botB);

    const routines = createRoutinesRepository(db);
    const tenantA = routines.forOwner(userA.id);
    tenantA.insert(makeRoutine({ id: "owned-routine", botId: botA.id }));
    routines.forOwner(userB.id).insert(makeRoutine({ id: "foreign-collision", botId: botB.id }));
    expect(tenantA.get("owned-routine")).not.toBeNull();

    for (const botId of [botB.id, legacyBot.id, randomUUID(), "not-a-uuid"]) {
      expect(() => tenantA.insert(makeRoutine({ id: `rejected-${botId}`, botId }))).toThrow(/owned bot not found/);
    }
    expect(() => tenantA.insert(makeRoutine({ id: "foreign-collision", botId: botA.id }))).toThrow(/UNIQUE/i);
    expect(() => routines.forOwner("not-an-owner-uuid")).toThrow(/internal UUID/);

    expect(tenantA.list().map((routine) => routine.id)).toEqual(["owned-routine"]);
    expect(db.prepare<{ n: number }>("SELECT count(*) AS n FROM routines").get()?.n).toBe(2);
    expect(db.prepare<{ n: number }>("SELECT count(*) AS n FROM routine_runs").get()?.n).toBe(0);
  });

  it("owner delete and deleteForBot remove only owned routines and their run rows", () => {
    const identity = new IdentitySessions(db);
    const userA = identity.upsertGithubIdentity({ githubId: 601, login: "delete-a" }, 1_000);
    const userB = identity.upsertGithubIdentity({ githubId: 602, login: "delete-b" }, 1_000);
    const bots = createBotsRepository(db);
    const legacyBot = makeBot({ id: "legacy-bot" });
    const botA = makeBot({ id: "bot-a" });
    const botB = makeBot({ id: "bot-b" });
    bots.insert(legacyBot);
    bots.forOwner(userA.id).insert(botA);
    bots.forOwner(userB.id).insert(botB);

    const routines = createRoutinesRepository(db);
    const tenantA = routines.forOwner(userA.id);
    const tenantB = routines.forOwner(userB.id);
    const legacy = makeRoutine({ id: "legacy", botId: legacyBot.id });
    const deleteOne = makeRoutine({ id: "delete-one", botId: botA.id });
    const deleteWithBot = makeRoutine({ id: "delete-with-bot", botId: botA.id });
    const keepB = makeRoutine({ id: "keep-b", botId: botB.id });
    routines.insert(legacy);
    tenantA.insert(deleteOne);
    tenantA.insert(deleteWithBot);
    tenantB.insert(keepB);
    routines.claimRun(claimInput({ routineId: legacy.id, botId: legacyBot.id, idempotencyKey: "legacy@1000" }));
    tenantA.claimRun(claimInput({ routineId: deleteOne.id, botId: botA.id, idempotencyKey: "delete-one@1000" }));
    tenantA.claimRun(claimInput({ routineId: deleteWithBot.id, botId: botA.id, idempotencyKey: "delete-with-bot@1000" }));
    tenantB.claimRun(claimInput({ routineId: keepB.id, botId: botB.id, idempotencyKey: "keep-b@1000" }));

    expect(tenantA.delete(keepB.id)).toBe(false);
    expect(tenantA.delete(legacy.id)).toBe(false);
    expect(tenantA.deleteForBot(botB.id)).toEqual([]);
    expect(tenantA.deleteForBot(legacyBot.id)).toEqual([]);
    expect(tenantA.delete(deleteOne.id)).toBe(true);
    expect(routines.runsFor(deleteOne.id)).toEqual([]);
    expect(tenantA.deleteForBot(botA.id)).toEqual([deleteWithBot.id]);
    expect(routines.runsFor(deleteWithBot.id)).toEqual([]);

    expect(tenantB.get(keepB.id)).not.toBeNull();
    expect(tenantB.runsFor(keepB.id)).toHaveLength(1);
    expect(routines.get(legacy.id)).not.toBeNull();
    expect(routines.runsFor(legacy.id)).toHaveLength(1);
    expect(db.prepare<{ n: number }>("SELECT count(*) AS n FROM routines").get()?.n).toBe(2);
    expect(db.prepare<{ n: number }>("SELECT count(*) AS n FROM routine_runs").get()?.n).toBe(2);
  });
});

describe("computer bindings repository", () => {
  let db: SqliteDatabase;
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    db = openDatabase(defaultDbPath());
  });
  afterEach(() => {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  });

  it("records, upserts, lists, and deletes bot→box bindings", () => {
    const bindings = createComputerBindingsRepository(db);
    bindings.record("bot-1", "box-a", 1_000);
    bindings.record("bot-2", "box-b", 1_500);
    expect(bindings.get("bot-1")).toMatchObject({ botId: "bot-1", boxId: "box-a", createdAt: 1_000 });
    bindings.record("bot-1", "box-c", 2_000);
    expect(bindings.get("bot-1")).toMatchObject({ boxId: "box-c", createdAt: 1_000, updatedAt: 2_000 });
    expect(bindings.list().map((b) => b.botId)).toEqual(["bot-1", "bot-2"]);
    expect(bindings.delete("bot-1")).toBe(true);
    expect(bindings.delete("bot-1")).toBe(false);
    expect(bindings.get("bot-1")).toBeNull();
  });
});
