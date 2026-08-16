// Domain services over the real repositories (in a temp home), with a FAKE
// CLOCK for the scheduler — the proactive.ts pattern: pass `now`, call
// tick(), no sleeps, no timers.
import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "../config.ts";
import { defaultDbPath, openDatabase } from "../db/database.ts";
import type { SqliteDatabase } from "../db/sqlite-native.ts";
import { createRepositories, type Repositories } from "../repositories/index.ts";
import { createBotsService, type BotsService } from "./bots.ts";
import { CATCH_UP_CAP, createRoutinesService, ROUTINE_LEASE_MS, type RoutinesService } from "./routines.ts";

const selection = () => ({ instanceId: "claude", model: "claude-sonnet-5" });

describe("bots service", () => {
  let db: SqliteDatabase;
  let repos: Repositories;
  let bots: BotsService;
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    db = openDatabase(defaultDbPath());
    repos = createRepositories(db);
    bots = createBotsService({ repos, defaultSelection: selection });
  });
  afterEach(() => {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  });

  const reopened = (): BotsService => {
    db.close();
    db = openDatabase(defaultDbPath());
    repos = createRepositories(db);
    return createBotsService({ repos, defaultSelection: selection });
  };

  it("creates an off/IDLE bot with greeting and onboarding card", () => {
    const bot = bots.createBot();
    expect(bot).toMatchObject({ modelSelection: selection(), computer: "off", state: "IDLE" });
    expect(bots.messagesFor(bot.threadId).map((m) => m.kind)).toEqual(["text", "options"]);
  });

  it("rotates colors and icon shapes", () => {
    const first = bots.createBot();
    const second = bots.createBot();
    expect(first.color).not.toBe(second.color);
    expect(first.iconShape).not.toBe(second.iconShape);
  });

  it("persists messages, cursors, usage, and notify overrides across restart", () => {
    const bot = bots.createBot();
    bots.patchBot(bot.id, { name: "Testy", notifyEvents: { "peer.reply": false, "turn.completed": true } });
    bots.setResumeCursor(bot.id, "claude", "sess-abc");
    bots.recordTurnUsage(bot.id, { input: 12, output: 5, cost: null });
    bots.appendMessage(bot.threadId, { role: "user", kind: "text", text: "hi" });
    const restarted = reopened();
    expect(restarted.bot(bot.id)).toMatchObject({
      name: "Testy",
      resumeCursors: { claude: "sess-abc" },
      usage: { input: 12, output: 5, cost: null },
      notifyEvents: { "peer.reply": false, "turn.completed": true },
    });
    expect(restarted.messagesFor(bot.threadId).at(-1)).toMatchObject({ text: "hi" });
  });

  it("recovers a crashed RUNNING bot as BLOCKED/interrupted on boot", () => {
    const bot = bots.createBot();
    bots.patchBot(bot.id, { busy: true, state: "RUNNING" });
    db.close();
    db = openDatabase(defaultDbPath());
    repos = createRepositories(db);
    repos.bots.recoverInterrupted(); // the composition root's boot pass
    const restarted = createBotsService({ repos, defaultSelection: selection });
    expect(restarted.bot(bot.id)).toMatchObject({ busy: false, state: "BLOCKED", stateDetail: "interrupted" });
  });

  it("rejects invalid bot and message patches", () => {
    const bot = bots.createBot();
    expect(() => bots.patchBot(bot.id, { computer: "auto" as never })).toThrow(/invalid computer/);
    expect(bots.patchMessage(bot.threadId, "missing", {})).toBeNull();
    expect(bots.patchBot("missing", { name: "x" })).toBeNull();
  });

  it("a patch that would break the record on reload is a 400, and the bot never vanishes (rc.14 item 1)", () => {
    const bot = bots.createBot();
    for (const bad of [
      { name: 123 as unknown as string },
      { modelSelection: "gpt-5.6-terra" as unknown as { instanceId: string; model: string } },
      { modelSelection: { model: "x" } as unknown as { instanceId: string; model: string } },
      { alwaysAllow: "yes" as unknown as boolean },
    ]) {
      expect(() => bots.patchBot(bot.id, bad)).toThrow(/invalid bot patch/);
    }
    // still listed and addressable, unchanged — never dropped by a read
    expect(bots.bots().some((b) => b.id === bot.id)).toBe(true);
    expect(bots.bot(bot.id)).toMatchObject({ id: bot.id, name: "New Bot" });
    expect(bots.patchBot(bot.id, { name: "Chief of Staff" })?.name).toBe("Chief of Staff");
  });

  it("field-scoped patches never write a stale name back (the suspected RMW clobber)", () => {
    // The CoS field map suspected a whole-record read-modify-write race
    // writing "New Bot" back over a rename. patchBot re-reads the row and
    // assigns ONLY the patched fields, and every writer is synchronous over
    // SQLite — a status flip after (or holding a record from before) a
    // rename must keep the rename.
    const stale = bots.createBot(); // record captured BEFORE the rename
    bots.patchBot(stale.id, { name: "Chief of Staff" });
    // turn-lifecycle style patches, as fired while a turn settles
    bots.patchBot(stale.id, { busy: true, state: "RUNNING", stateDetail: undefined });
    bots.recordTurnUsage(stale.id, { input: 3, output: 2, cost: null });
    bots.patchBot(stale.id, { busy: false, unread: true, state: "DONE" });
    expect(bots.bot(stale.id)).toMatchObject({ name: "Chief of Staff", state: "DONE", busy: false });
    expect(stale.name).toBe("New Bot"); // the stale in-memory copy stayed stale — it is never written back
  });

  it("seedIfEmpty creates Milind exactly once", () => {
    bots.seedIfEmpty();
    expect(bots.bots().map((b) => b.name)).toEqual(["Milind"]);
    bots.seedIfEmpty();
    expect(bots.count()).toBe(1);
  });

  it("clearSkillRefs strips a deleted skill from bots and routines", () => {
    const bot = bots.createBot();
    bots.patchBot(bot.id, { skillId: "skill-1" });
    repos.routines.insert({
      id: "r1",
      botId: bot.id,
      name: "R",
      prompt: "P",
      schedule: { kind: "interval", everyMinutes: 5 },
      enabled: true,
      running: false,
      nextRunAt: 1,
      lastRunAt: null,
      lastResult: null,
      createdAt: 1,
      missedPolicy: "run-once",
      skillId: "skill-1",
    });
    bots.clearSkillRefs("skill-1");
    expect(bots.bot(bot.id)?.skillId).toBeUndefined();
    expect(repos.routines.get("r1")?.skillId).toBeUndefined();
  });

  it("deleteBot removes transcript rows and the workspace dir", () => {
    const bot = bots.createBot();
    bots.appendMessage(bot.threadId, { role: "user", kind: "text", text: "later" });
    expect(bots.deleteBot(bot.id)).toBe(true);
    expect(bots.bot(bot.id)).toBeNull();
    expect(bots.messagesFor(bot.threadId)).toEqual([]);
    expect(bots.deleteBot(bot.id)).toBe(false);
  });
});

describe("routines service (fake clock)", () => {
  let db: SqliteDatabase;
  let repos: Repositories;
  let bots: BotsService;
  let routines: RoutinesService;
  let now: number;
  let started: Array<{ botId: string; text: string }>;
  let frames: unknown[];
  let busy: boolean;

  const makeService = (): RoutinesService =>
    createRoutinesService({
      repos,
      now: () => now,
      broadcast: (frame) => frames.push(frame),
      bot: (id) => {
        const b = bots.bot(id);
        return b ? { id: b.id, threadId: b.threadId, busy } : null;
      },
      startTurn: async (botId, text) => {
        started.push({ botId, text });
      },
      getSkill: () => null,
      skillPrompt: (_skill, prompt) => prompt,
    });

  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    db = openDatabase(defaultDbPath());
    repos = createRepositories(db);
    bots = createBotsService({ repos, defaultSelection: selection });
    now = 1_000_000;
    started = [];
    frames = [];
    busy = false;
    routines = makeService();
  });
  afterEach(() => {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  });

  const makeRoutine = (overrides: Partial<Parameters<RoutinesService["createRoutine"]>[0]> = {}) => {
    const bot = bots.createBot();
    const routine = routines.createRoutine({
      botId: bot.id,
      name: "Standup",
      prompt: "Brief me",
      schedule: { kind: "interval", everyMinutes: 15 },
      ...overrides,
    });
    return { bot, routine };
  };

  it("tick starts a due routine, records a leased run, and settleTurn finishes it", async () => {
    const { bot, routine } = makeRoutine();
    expect(routine.nextRunAt).toBe(now + 15 * 60_000);
    expect(routine.missedPolicy).toBe("run-once");

    routines.tick(now); // not due yet — the clock has not advanced
    expect(started).toEqual([]);

    const scheduledFor = routine.nextRunAt;
    now += 15 * 60_000 + 1;
    routines.tick(now);
    await Promise.resolve(); // let the fire-and-forget run settle
    expect(started).toEqual([{ botId: bot.id, text: "Brief me" }]);
    expect(routines.routine(routine.id)).toMatchObject({ running: true, lastResult: "running" });
    const open = repos.routines.runsFor(routine.id);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({
      status: "running",
      kind: "scheduled",
      attempt: 1,
      scheduled_for: scheduledFor,
      idempotency_key: `${routine.id}@${scheduledFor}`,
      lease_until: now + ROUTINE_LEASE_MS,
    });
    // the next occurrence stays on the schedule grid, anchored to the
    // occurrence rather than the (slightly late) tick
    expect(routines.routine(routine.id)?.nextRunAt).toBe(scheduledFor + 15 * 60_000);
    expect(frames.some((f) => (f as { kind?: string }).kind === "routine")).toBe(true);

    const thenStart = routines.settleTurn(bot.threadId, true);
    expect(thenStart).toBeNull();
    expect(routines.routine(routine.id)).toMatchObject({ running: false, lastResult: "DONE" });
    expect(repos.routines.runsFor(routine.id)[0]).toMatchObject({ result: "DONE", status: "done", finished_at: now });
  });

  it("skips a busy bot, reschedules, and records why", async () => {
    const { routine } = makeRoutine();
    busy = true;
    const scheduledFor = routine.nextRunAt;
    now += 15 * 60_000 + 1;
    routines.tick(now);
    await Promise.resolve();
    expect(started).toEqual([]);
    expect(routines.routine(routine.id)).toMatchObject({ running: false, lastResult: "skipped: bot busy" });
    expect(routines.routine(routine.id)?.nextRunAt).toBe(scheduledFor + 15 * 60_000);
    const runs = repos.routines.runsFor(routine.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "skipped", result: "skipped: bot busy", scheduled_for: scheduledFor });
  });

  it("crash mid-run: the lease lapses, the run closes as interrupted, and the occurrence never double-runs", async () => {
    const { routine } = makeRoutine();
    const scheduledFor = routine.nextRunAt;
    now = scheduledFor + 1;
    routines.tick(now);
    await Promise.resolve();
    expect(routines.routine(routine.id)?.running).toBe(true);

    // the process dies mid-run: a fresh service over the same database has
    // no in-memory run ownership, so the lease is never renewed again
    routines = makeService();
    now += ROUTINE_LEASE_MS - 1;
    routines.tick(now);
    // lease still live — the run is respected, nothing double-starts
    expect(repos.routines.runsFor(routine.id)[0].status).toBe("running");

    now += 1;
    started = [];
    routines.tick(now);
    await Promise.resolve();
    const runs = repos.routines.runsFor(routine.id);
    expect(runs.map((r) => r.status)).toContain("interrupted");
    expect(runs.find((r) => r.status === "interrupted")).toMatchObject({
      scheduled_for: scheduledFor,
      result: "interrupted: VelarixBot quit mid-run",
    });
    expect(routines.routine(routine.id)?.running).toBe(false);
    // the interrupted occurrence itself is settled; only newer occurrences
    // may run, and exactly one row exists for the crashed one
    expect(runs.filter((r) => r.scheduled_for === scheduledFor)).toHaveLength(1);
    for (const call of started) expect(call.botId).toBeTruthy();
  });

  it("boot recovery closes orphaned runs immediately and never replays the occurrence", async () => {
    const { routine } = makeRoutine();
    const scheduledFor = routine.nextRunAt;
    now = scheduledFor + 1;
    routines.tick(now);
    await Promise.resolve();
    expect(routines.routine(routine.id)?.running).toBe(true);

    // restart: app.ts calls recoverInterrupted before the first tick
    expect(repos.routines.recoverInterrupted(now + 5_000)).toBe(1);
    routines = makeService();
    expect(routines.routine(routine.id)?.running).toBe(false);

    // simulate the worst crash window: the run row committed but the
    // advanced nextRunAt did not — the idempotency key still wins
    const r = routines.routine(routine.id)!;
    routines.markRoutine(routine.id, { nextRunAt: scheduledFor });
    started = [];
    routines.tick(now + 5_001);
    await Promise.resolve();
    expect(started).toEqual([]); // no double-run
    expect(repos.routines.runsFor(r.id).filter((run) => run.scheduled_for === scheduledFor)).toHaveLength(1);
    // and the schedule moved on instead of wedging
    expect(routines.routine(routine.id)!.nextRunAt).toBeGreaterThan(scheduledFor);
  });

  it("missed policy skip: drops the backlog and records why", async () => {
    const { routine } = makeRoutine({ missedPolicy: "skip" });
    const firstDue = routine.nextRunAt;
    now = firstDue + 4 * 15 * 60_000; // asleep through 5 occurrences
    routines.tick(now);
    await Promise.resolve();
    expect(started).toEqual([]);
    const runs = repos.routines.runsFor(routine.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("skipped");
    expect(runs[0].result).toBe("skipped: 5 missed runs while VelarixBot was closed or asleep (policy: skip)");
    expect(routines.routine(routine.id)!.nextRunAt).toBeGreaterThan(now);
  });

  it("missed policy run-once (default): coalesces the backlog into one run", async () => {
    const { bot, routine } = makeRoutine();
    const firstDue = routine.nextRunAt;
    const latest = firstDue + 3 * 15 * 60_000;
    now = latest + 1_000; // 4 occurrences due, well past grace
    routines.tick(now);
    await Promise.resolve();
    expect(started).toEqual([{ botId: bot.id, text: "Brief me" }]);
    const runs = repos.routines.runsFor(routine.id);
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({ status: "running", scheduled_for: latest });
    expect(runs[1].status).toBe("skipped");
    expect(runs[1].result).toBe("skipped: 3 of 4 missed runs while VelarixBot was closed or asleep coalesced into one run (policy: run-once)");
    routines.settleTurn(bot.threadId, true);
    expect(routines.routine(routine.id)!.nextRunAt).toBe(latest + 15 * 60_000);
  });

  it("missed policy catch-up: replays the backlog in order, one at a time", async () => {
    const { bot, routine } = makeRoutine({ missedPolicy: "catch-up" });
    const firstDue = routine.nextRunAt;
    now = firstDue + 2 * 15 * 60_000 + 1_000; // 3 occurrences due
    for (let i = 0; i < 3; i++) {
      routines.tick(now);
      await Promise.resolve();
      routines.settleTurn(bot.threadId, true);
    }
    expect(started).toHaveLength(3);
    const runs = repos.routines.runsFor(routine.id);
    expect(runs.map((r) => r.scheduled_for).reverse()).toEqual([firstDue, firstDue + 15 * 60_000, firstDue + 30 * 60_000]);
    expect(runs.every((r) => r.status === "done")).toBe(true);
    // caught up: nothing more is due
    started = [];
    routines.tick(now);
    await Promise.resolve();
    expect(started).toEqual([]);
  });

  it("missed policy catch-up: caps the backlog and records the overflow", async () => {
    const { bot, routine } = makeRoutine({ missedPolicy: "catch-up", schedule: { kind: "interval", everyMinutes: 1 } });
    const firstDue = routine.nextRunAt;
    now = firstDue + 49 * 60_000; // 50 occurrences due — 30 over the cap
    routines.tick(now);
    await Promise.resolve();
    const runs = repos.routines.runsFor(routine.id);
    const skip = runs.find((r) => r.status === "skipped")!;
    expect(skip.result).toBe(`skipped: 30 oldest of 50 missed runs while VelarixBot was closed or asleep (catch-up cap ${CATCH_UP_CAP})`);
    // the first replayed occurrence is #31
    expect(runs.find((r) => r.status === "running")!.scheduled_for).toBe(firstDue + 30 * 60_000);
    routines.settleTurn(bot.threadId, true);
  });

  it("manual test run: records a manual row and never consumes the schedule", async () => {
    const { bot, routine } = makeRoutine();
    const nextBefore = routine.nextRunAt;
    const outcome = await routines.runRoutine(routine.id);
    expect(outcome).toEqual({ started: true });
    expect(started).toHaveLength(1);
    expect(routines.routine(routine.id)).toMatchObject({ running: true, lastResult: "running (test run)", nextRunAt: nextBefore });
    expect(repos.routines.runsFor(routine.id)[0]).toMatchObject({ kind: "manual", status: "running", idempotency_key: null });

    // no overlapping second run
    expect(await routines.runRoutine(routine.id)).toEqual({ started: false, reason: "already running" });
    routines.settleTurn(bot.threadId, true);
    expect(routines.routine(routine.id)?.nextRunAt).toBe(nextBefore);

    // a paused routine can still be test-run
    routines.patchRoutine(routine.id, { enabled: false });
    expect((await routines.runRoutine(routine.id)).started).toBe(true);
    routines.settleTurn(bot.threadId, true);

    // a busy bot refuses instead of queueing
    busy = true;
    expect(await routines.runRoutine(routine.id)).toEqual({ started: false, reason: "bot busy" });
    expect(await routines.runRoutine("nope")).toEqual({ started: false, reason: "no such routine" });
  });

  it("stamps clock schedules with the host time zone at create and edit", () => {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const { routine } = makeRoutine({ schedule: { kind: "daily", time: "09:00" } });
    expect(routine.schedule).toEqual({ kind: "daily", time: "09:00", timeZone: zone });
    const patched = routines.patchRoutine(routine.id, { schedule: { kind: "weekdays", time: "08:30" } })!;
    expect(patched.schedule).toEqual({ kind: "weekdays", time: "08:30", timeZone: zone });
    // an explicit zone is preserved verbatim; a bogus one is rejected
    const explicit = routines.patchRoutine(routine.id, { schedule: { kind: "daily", time: "07:00", timeZone: "Asia/Tokyo" } })!;
    expect(explicit.schedule).toEqual({ kind: "daily", time: "07:00", timeZone: "Asia/Tokyo" });
    expect(() => routines.patchRoutine(routine.id, { schedule: { kind: "daily", time: "07:00", timeZone: "Mars/Olympus" } })).toThrow(
      /invalid time zone/,
    );
    expect(() => routines.createRoutine({ botId: routine.botId, name: "x", prompt: "y", schedule: { kind: "daily", time: "09:00" }, missedPolicy: "sometimes" })).toThrow(/invalid missed policy/);
  });

  it("disables a routine whose bot is gone", async () => {
    const { bot, routine } = makeRoutine();
    repos.deleteBotCascade(bot.id); // routine dies with the bot cascade
    expect(routines.routine(routine.id)).toBeNull();

    // an orphaned routine (bot vanished outside the cascade) disables itself
    repos.routines.insert({ ...routine, id: "orphan", botId: "gone" });
    now += 15 * 60_000 + 1;
    await routines.runRoutine("orphan");
    expect(routines.routine("orphan")).toMatchObject({ enabled: false, lastResult: "blocked: no such bot" });
  });

  it("broadcasts routine.deleted on delete and refuses ownership rewrites", () => {
    const { bot, routine } = makeRoutine({ name: "Safe", prompt: "Do it" });
    routines.patchRoutine(routine.id, { name: "Renamed", id: "forged", running: true } as never);
    expect(routines.routine(routine.id)).toMatchObject({ id: routine.id, botId: bot.id, name: "Renamed", running: false });
    expect(routines.deleteRoutine(routine.id)).toBe(true);
    expect(frames.at(-1)).toEqual({ kind: "routine.deleted", routineId: routine.id });
    expect(routines.deleteRoutine(routine.id)).toBe(false);
    expect(routines.markRoutine(routine.id, { lastResult: "gone" })).toBeNull();
  });
});
