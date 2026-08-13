// Durable product-foundation persistence tests.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { LAST_BOT_ERROR, Store, wouldEmptyWorkspace, nextRunAt, type BotRecord } from "./store.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });

describe("Store", () => {
  beforeEach(() => rmSync(DATA_DIR, { recursive: true, force: true }));

  it("creates an off/IDLE bot with greeting and onboarding card", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    expect(bot).toMatchObject({ modelSelection: selection(), computer: "off", state: "IDLE" });
    expect(store.messagesFor(bot.threadId).map((m) => m.kind)).toEqual(["text", "options"]);
  });

  it("rotates colors", () => {
    const store = new Store(selection);
    expect(store.createBot().color).not.toBe(store.createBot().color);
  });

  it("persists messages, resume cursors, and usage across restart", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    store.patchBot(bot.id, { name: "Testy" });
    store.setResumeCursor(bot.id, "claude", "sess-abc");
    store.recordTurnUsage(bot.id, { input: 12, output: 5, cost: null });
    store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "hi" });
    const reloaded = new Store(selection);
    expect(reloaded.bot(bot.id)).toMatchObject({
      name: "Testy",
      resumeCursors: { claude: "sess-abc" },
      usage: { input: 12, output: 5, cost: null },
    });
    expect(reloaded.messagesFor(bot.threadId).at(-1)).toMatchObject({ text: "hi" });
  });

  it("persists per-event notification overrides", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    store.patchBot(bot.id, { notifyEvents: { "peer.reply": false, "turn.completed": true } });
    const reloaded = new Store(selection);
    expect(reloaded.bot(bot.id)?.notifyEvents).toMatchObject({ "peer.reply": false, "turn.completed": true });
  });

  it("recovers a crashed RUNNING bot as BLOCKED/interrupted", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    store.patchBot(bot.id, { busy: true, state: "RUNNING" });
    const reloaded = new Store(selection);
    expect(reloaded.bot(bot.id)).toMatchObject({ busy: false, state: "BLOCKED", stateDetail: "interrupted" });
  });

  it("migrates legacy records without losing cursors", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const file = join(DATA_DIR, "bots.json");
    const legacy: BotRecord[] = JSON.parse(readFileSync(file, "utf8"));
    delete (legacy[0] as Partial<BotRecord>).computer;
    delete (legacy[0] as Partial<BotRecord>).state;
    legacy[0].resumeCursors = { codex: "cursor" };
    writeFileSync(file, JSON.stringify(legacy));
    const reloaded = new Store(selection);
    expect(reloaded.bot(bot.id)).toMatchObject({ computer: "off", state: "IDLE", resumeCursors: { codex: "cursor" } });
  });

  it("atomically writes a backup and recovers a corrupt primary", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    store.patchBot(bot.id, { name: "Backed up" });
    store.patchBot(bot.id, { title: "latest" });
    const file = join(DATA_DIR, "bots.json");
    expect(existsSync(`${file}.bak`)).toBe(true);
    writeFileSync(file, "{corrupt");
    const recovered = new Store(selection);
    expect(recovered.bot(bot.id)?.name).toBe("Backed up");
    expect(JSON.parse(readFileSync(file, "utf8"))).toBeInstanceOf(Array);
  });

  it("rejects invalid bot and message patches", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    expect(() => store.patchBot(bot.id, { computer: "auto" as never })).toThrow(/invalid computer/);
    expect(store.patchMessage(bot.threadId, "missing", {})).toBeNull();
  });

  it("deletes bot transcript, backup, and workspace", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "later" });
    const file = join(DATA_DIR, `messages-${bot.threadId}.json`);
    const bak = `${file}.bak`;
    expect(existsSync(bak)).toBe(true);
    const ws = join(DATA_DIR, "workspaces", bot.id);
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, "note.txt"), "scratch");
    expect(store.deleteBot(bot.id)).toBe(true);
    expect(existsSync(file)).toBe(false);
    expect(existsSync(bak)).toBe(false);
    expect(existsSync(ws)).toBe(false);
  });

  it("wouldEmptyWorkspace is the last-bot product rule", () => {
    expect(wouldEmptyWorkspace(0)).toBe(true);
    expect(wouldEmptyWorkspace(1)).toBe(true);
    expect(wouldEmptyWorkspace(2)).toBe(false);
    expect(LAST_BOT_ERROR).toMatch(/last bot/i);
  });

  it("persists routine CRUD and schedule metadata", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const routine = store.createRoutine({ botId: bot.id, name: "Check inbox", prompt: "Check inbox", schedule: { kind: "interval", everyMinutes: 15 } });
    expect(routine).toMatchObject({ enabled: true, running: false, lastRunAt: null, lastResult: null });
    expect(routine.nextRunAt).toBeGreaterThan(Date.now());
    store.patchRoutine(routine.id, { enabled: false });
    store.markRoutine(routine.id, { lastRunAt: 123, lastResult: "done" });
    expect(new Store(selection).routine(routine.id)).toMatchObject({ enabled: false, lastRunAt: 123, lastResult: "done" });
    expect(store.deleteRoutine(routine.id)).toBe(true);
  });

  it("broadcasts routine and routine.deleted frames from markRoutine and delete", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const frames: unknown[] = [];
    store.onRoutine = (routine) => frames.push({ kind: "routine", routine });
    store.onRoutineDeleted = (routineId) => frames.push({ kind: "routine.deleted", routineId });
    const routine = store.createRoutine({ botId: bot.id, name: "Ping", prompt: "Ping", schedule: { kind: "interval", everyMinutes: 15 } });
    expect(frames).toEqual([]);
    store.markRoutine(routine.id, { lastResult: "running", running: true });
    expect(frames).toEqual([
      { kind: "routine", routine: expect.objectContaining({ id: routine.id, lastResult: "running", running: true }) },
    ]);
    expect(store.deleteRoutine(routine.id)).toBe(true);
    expect(frames[1]).toEqual({ kind: "routine.deleted", routineId: routine.id });
    expect(store.markRoutine(routine.id, { lastResult: "gone" })).toBeNull();
    expect(frames).toHaveLength(2);
  });

  it("round-trips a daily HH:MM create payload", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const routine = store.createRoutine({
      botId: bot.id,
      name: "Morning",
      prompt: "Brief me",
      schedule: { kind: "daily", time: "09:30" },
    });
    expect(routine.schedule).toEqual({ kind: "daily", time: "09:30" });
    expect(new Store(selection).routine(routine.id)?.schedule).toEqual({ kind: "daily", time: "09:30" });
  });

  it("persists requireApproval and a routine thenStartTurn trigger", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const other = store.createBot();
    store.patchBot(bot.id, { requireApproval: true });
    const routine = store.createRoutine({
      botId: bot.id,
      name: "Brief",
      prompt: "Brief me",
      schedule: { kind: "interval", everyMinutes: 30 },
      thenStartTurn: { botId: other.id, prompt: "Follow up." },
    });
    expect(routine.thenStartTurn).toEqual({ botId: other.id, prompt: "Follow up." });
    const reloaded = new Store(selection);
    expect(reloaded.bot(bot.id)?.requireApproval).toBe(true);
    expect(reloaded.routine(routine.id)?.thenStartTurn).toEqual({ botId: other.id, prompt: "Follow up." });
  });

  it("persists enabledApps, a bot skillId, and a routine skillId", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    store.patchBot(bot.id, { enabledApps: ["googledrive"], skillId: "skill-bot" });
    const routine = store.createRoutine({
      botId: bot.id,
      name: "Taught",
      prompt: "Do it",
      schedule: { kind: "interval", everyMinutes: 20 },
      skillId: "skill-1",
    });
    const reloaded = new Store(selection);
    expect(reloaded.bot(bot.id)?.enabledApps).toEqual(["googledrive"]);
    expect(reloaded.bot(bot.id)?.skillId).toBe("skill-bot");
    expect(reloaded.routine(routine.id)?.skillId).toBe("skill-1");
  });

  it("persists icon shape, rotates defaults, and falls back for legacy bots", () => {
    const store = new Store(selection);
    const first = store.createBot();
    const second = store.createBot();
    expect(first.iconShape).toBe("cursor");
    expect(second.iconShape).not.toBe(first.iconShape);
    store.patchBot(first.id, { iconShape: "hexagon" });
    expect(new Store(selection).bot(first.id)?.iconShape).toBe("hexagon");
    store.patchBot(first.id, { iconShape: "not-a-shape" as never });
    expect(store.bot(first.id)?.iconShape).toBe("cursor");
    const file = join(DATA_DIR, "bots.json");
    const legacy = JSON.parse(readFileSync(file, "utf8"));
    delete legacy[0].iconShape;
    writeFileSync(file, JSON.stringify(legacy));
    expect(new Store(selection).bot(second.id)?.iconShape).toBe("cursor");
  });

  it("validates daily and interval routines", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    expect(() => store.createRoutine({ botId: bot.id, name: "x", prompt: "x", schedule: { kind: "interval", everyMinutes: 0 } })).toThrow();
    expect(() => store.createRoutine({ botId: bot.id, name: "x", prompt: "x", schedule: { kind: "daily", time: "25:00" } })).toThrow();
  });

  it("does not allow public routine patches to rewrite ownership or scheduler state", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const routine = store.createRoutine({ botId: bot.id, name: "Safe", prompt: "Do it", schedule: { kind: "interval", everyMinutes: 15 } });
    store.patchRoutine(routine.id, { name: "Renamed", id: "forged", running: true } as never);
    expect(store.routine(routine.id)).toMatchObject({ id: routine.id, botId: bot.id, name: "Renamed", running: false });
  });

  it("round-trips weekdays and listener schedules", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const weekdays = store.createRoutine({
      botId: bot.id,
      name: "Standup",
      prompt: "Brief me",
      schedule: { kind: "weekdays", time: "09:00" },
    });
    expect(weekdays.schedule).toEqual({ kind: "weekdays", time: "09:00" });
    expect(new Store(selection).routine(weekdays.id)?.schedule).toEqual({ kind: "weekdays", time: "09:00" });
    const saturday = new Date(2026, 7, 15, 10, 0, 0).getTime();
    const next = nextRunAt({ kind: "weekdays", time: "09:00" }, saturday);
    expect(new Date(next).getDay()).toBe(1);

    const listener = store.createRoutine({
      botId: bot.id,
      name: "PRs",
      prompt: "Check PRs",
      schedule: { kind: "listener", source: "github" },
    });
    expect(listener.schedule).toEqual({ kind: "listener", source: "github", everyMinutes: 15 });
    expect(nextRunAt(listener.schedule, 1_000)).toBe(1_000 + 15 * 60_000);
    expect(() => store.createRoutine({ botId: bot.id, name: "x", prompt: "x", schedule: { kind: "listener", source: "discord" as never } })).toThrow(/github or slack/);
  });
});
