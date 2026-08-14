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
import { createRoutinesService, type RoutinesService } from "./routines.ts";

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

  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    db = openDatabase(defaultDbPath());
    repos = createRepositories(db);
    bots = createBotsService({ repos, defaultSelection: selection });
    now = 1_000_000;
    started = [];
    frames = [];
    busy = false;
    routines = createRoutinesService({
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
  });
  afterEach(() => {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  });

  it("tick starts a due routine, records a run, and settleTurn finishes it", async () => {
    const bot = bots.createBot();
    const routine = routines.createRoutine({
      botId: bot.id,
      name: "Standup",
      prompt: "Brief me",
      schedule: { kind: "interval", everyMinutes: 15 },
    });
    expect(routine.nextRunAt).toBe(now + 15 * 60_000);

    routines.tick(now); // not due yet — the clock has not advanced
    expect(started).toEqual([]);

    now += 15 * 60_000 + 1;
    routines.tick(now);
    await Promise.resolve(); // let the fire-and-forget run settle
    expect(started).toEqual([{ botId: bot.id, text: "Brief me" }]);
    expect(routines.routine(routine.id)).toMatchObject({ running: true, lastResult: "running" });
    expect(repos.routines.runsFor(routine.id)).toHaveLength(1);
    expect(frames.some((f) => (f as { kind?: string }).kind === "routine")).toBe(true);

    const thenStart = routines.settleTurn(bot.threadId, true);
    expect(thenStart).toBeNull();
    expect(routines.routine(routine.id)).toMatchObject({ running: false, lastResult: "DONE" });
    expect(repos.routines.runsFor(routine.id)[0]).toMatchObject({ result: "DONE", finished_at: now });
  });

  it("skips a busy bot and reschedules without a run row", async () => {
    const bot = bots.createBot();
    const routine = routines.createRoutine({
      botId: bot.id,
      name: "Standup",
      prompt: "Brief me",
      schedule: { kind: "interval", everyMinutes: 15 },
    });
    busy = true;
    now += 15 * 60_000 + 1;
    routines.tick(now);
    await Promise.resolve();
    expect(started).toEqual([]);
    expect(routines.routine(routine.id)).toMatchObject({ running: false, lastResult: "skipped: bot busy" });
    expect(routines.routine(routine.id)?.nextRunAt).toBe(now + 15 * 60_000);
    expect(repos.routines.runsFor(routine.id)).toEqual([]);
  });

  it("disables a routine whose bot is gone", async () => {
    const bot = bots.createBot();
    const routine = routines.createRoutine({
      botId: bot.id,
      name: "Standup",
      prompt: "Brief me",
      schedule: { kind: "interval", everyMinutes: 15 },
    });
    repos.deleteBotCascade(bot.id); // routine dies with the bot cascade
    expect(routines.routine(routine.id)).toBeNull();

    // an orphaned routine (bot vanished outside the cascade) disables itself
    repos.routines.insert({ ...routine, id: "orphan", botId: "gone" });
    now += 15 * 60_000 + 1;
    await routines.runRoutine("orphan");
    expect(routines.routine("orphan")).toMatchObject({ enabled: false, lastResult: "blocked: no such bot" });
  });

  it("broadcasts routine.deleted on delete and refuses ownership rewrites", () => {
    const bot = bots.createBot();
    const routine = routines.createRoutine({
      botId: bot.id,
      name: "Safe",
      prompt: "Do it",
      schedule: { kind: "interval", everyMinutes: 15 },
    });
    routines.patchRoutine(routine.id, { name: "Renamed", id: "forged", running: true } as never);
    expect(routines.routine(routine.id)).toMatchObject({ id: routine.id, botId: bot.id, name: "Renamed", running: false });
    expect(routines.deleteRoutine(routine.id)).toBe(true);
    expect(frames.at(-1)).toEqual({ kind: "routine.deleted", routineId: routine.id });
    expect(routines.deleteRoutine(routine.id)).toBe(false);
    expect(routines.markRoutine(routine.id, { lastResult: "gone" })).toBeNull();
  });
});
