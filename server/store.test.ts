// Durable product-foundation persistence tests.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { Store, type BotRecord } from "./store.ts";

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

  it("deletes bot and transcript", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const file = join(DATA_DIR, `messages-${bot.threadId}.json`);
    expect(store.deleteBot(bot.id)).toBe(true);
    expect(existsSync(file)).toBe(false);
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
});
