// Routine repository: CRUD, schedule round-trips, and the routine_runs
// history.
import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "../config.ts";
import { defaultDbPath, openDatabase } from "../db/database.ts";
import type { SqliteDatabase } from "../db/sqlite-native.ts";
import type { RoutineRecord } from "../store.ts";
import { createComputerBindingsRepository } from "./computer-bindings.ts";
import { createRoutinesRepository } from "./routines.ts";

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
    const listener = makeRoutine({ schedule: { kind: "listener", source: "github", everyMinutes: 15 } });
    routines.insert(daily);
    routines.insert(listener);
    routines.update({ ...daily, enabled: false, lastRunAt: 123, lastResult: "done" });
    db.close();
    db = openDatabase(defaultDbPath());
    const reloaded = createRoutinesRepository(db);
    expect(reloaded.get(daily.id)).toMatchObject({ schedule: { kind: "daily", time: "09:30" }, enabled: false, lastRunAt: 123, lastResult: "done" });
    expect(reloaded.get(listener.id)?.schedule).toEqual({ kind: "listener", source: "github", everyMinutes: 15 });
    expect(reloaded.list().map((r) => r.id)).toEqual([daily.id, listener.id]);
    expect(reloaded.delete(daily.id)).toBe(true);
    expect(reloaded.delete(daily.id)).toBe(false);
  });

  it("records one routine_runs row per started run and finishes it in place", () => {
    const routines = createRoutinesRepository(db);
    const routine = makeRoutine();
    routines.insert(routine);
    routines.startRun(routine, 1_000);
    routines.finishRun(routine.id, "DONE", 2_000);
    routines.startRun(routine, 3_000);
    routines.finishRun(routine.id, "BLOCKED: failed", 4_000);
    const runs = routines.runsFor(routine.id);
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({ started_at: 1_000, finished_at: 2_000, result: "DONE" });
    expect(runs[1]).toMatchObject({ started_at: 3_000, finished_at: 4_000, result: "BLOCKED: failed" });
    // finishing with no open run is a no-op, never a crash
    routines.finishRun(routine.id, "late", 5_000);
    expect(routines.runsFor(routine.id)).toHaveLength(2);
  });

  it("deleteForBot removes the bot's routines and run history", () => {
    const routines = createRoutinesRepository(db);
    routines.insert(makeRoutine({ id: "keep", botId: "other" }));
    routines.insert(makeRoutine({ id: "drop-1" }));
    routines.insert(makeRoutine({ id: "drop-2" }));
    routines.startRun({ id: "drop-1", botId: "bot-1" }, 1);
    expect(routines.deleteForBot("bot-1").sort()).toEqual(["drop-1", "drop-2"]);
    expect(routines.list().map((r) => r.id)).toEqual(["keep"]);
    expect(routines.runsFor("drop-1")).toEqual([]);
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
