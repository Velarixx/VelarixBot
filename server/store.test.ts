// Domain-model helpers: normalization, schedules, product rules. The
// persistence behaviors that used to live here moved with the data to
// server/repositories/*.test.ts and server/services/services.test.ts.
import { describe, expect, it } from "vitest";

import {
  LAST_BOT_ERROR,
  mentionedBots,
  nextRunAt,
  normalizeBot,
  normalizeRoutine,
  parseRoutineSchedule,
  resolveIconShape,
  wouldEmptyWorkspace,
  type BotRecord,
} from "./store.ts";

const baseBot = {
  id: "bot-1",
  threadId: "thread-1",
  name: "Testy",
  modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
};

describe("bot record normalization", () => {
  it("fills defaults for legacy records without losing cursors", () => {
    const bot = normalizeBot({ ...baseBot, resumeCursors: { codex: "cursor" } });
    expect(bot).toMatchObject({ computer: "off", state: "IDLE", color: "blue", iconShape: "cursor", resumeCursors: { codex: "cursor" } });
  });

  it("rejects unrecognizable records", () => {
    expect(normalizeBot(null)).toBeNull();
    expect(normalizeBot({ id: "x" })).toBeNull();
    expect(normalizeBot({ ...baseBot, modelSelection: {} })).toBeNull();
  });

  it("flips a crashed RUNNING record only when recovery is asked for", () => {
    const raw = { ...baseBot, busy: true, state: "RUNNING" };
    expect(normalizeBot(raw)).toMatchObject({ busy: true, state: "RUNNING" });
    expect(normalizeBot(raw, { recoverInterrupted: true })).toMatchObject({ busy: false, state: "BLOCKED", stateDetail: "interrupted" });
  });

  it("keeps only valid notify events and string lists", () => {
    const bot = normalizeBot({
      ...baseBot,
      notifyEvents: { "peer.reply": false, bogus: true, "turn.completed": "yes" },
      enabledApps: ["googledrive", "", 42],
      threadParticipants: ["a", "b"],
    } as unknown as Partial<BotRecord>);
    expect(bot?.notifyEvents).toEqual({ "peer.reply": false });
    expect(bot?.enabledApps).toEqual(["googledrive", "42"]);
    expect(bot?.threadParticipants).toEqual(["a", "b"]);
  });

  it("resolves icon shapes with a cursor fallback", () => {
    expect(resolveIconShape("hexagon")).toBe("hexagon");
    expect(resolveIconShape("not-a-shape")).toBe("cursor");
  });
});

describe("routine schedules", () => {
  it("round-trips daily, weekdays, interval, and listener schedules", () => {
    expect(parseRoutineSchedule({ kind: "daily", time: "09:30" })).toEqual({ kind: "daily", time: "09:30" });
    expect(parseRoutineSchedule({ kind: "weekdays", time: "09:00" })).toEqual({ kind: "weekdays", time: "09:00" });
    expect(parseRoutineSchedule({ kind: "interval", everyMinutes: 15 })).toEqual({ kind: "interval", everyMinutes: 15 });
    expect(parseRoutineSchedule({ kind: "listener", source: "github" })).toEqual({ kind: "listener", source: "github", everyMinutes: 15 });
  });

  it("rejects invalid schedules", () => {
    expect(() => parseRoutineSchedule({ kind: "interval", everyMinutes: 0 })).toThrow();
    expect(() => parseRoutineSchedule({ kind: "daily", time: "25:00" })).toThrow();
    expect(() => parseRoutineSchedule({ kind: "listener", source: "discord" })).toThrow(/github or slack/);
  });

  it("weekdays schedules skip the weekend", () => {
    const saturday = new Date(2026, 7, 15, 10, 0, 0).getTime();
    const next = nextRunAt({ kind: "weekdays", time: "09:00" }, saturday);
    expect(new Date(next).getDay()).toBe(1);
    expect(nextRunAt({ kind: "listener", source: "github", everyMinutes: 15 }, 1_000)).toBe(1_000 + 15 * 60_000);
  });

  it("normalizes legacy routine records and resets running", () => {
    const routine = normalizeRoutine({
      id: "r1",
      botId: "b1",
      name: "R",
      prompt: "P",
      schedule: { kind: "interval", everyMinutes: 5 },
      running: true,
      nextRunAt: 42,
    });
    expect(routine).toMatchObject({ running: false, nextRunAt: 42, enabled: true, lastRunAt: null });
    expect(normalizeRoutine({ id: "r1" })).toBeNull();
  });
});

describe("workspace product rules", () => {
  it("wouldEmptyWorkspace is the last-bot product rule", () => {
    expect(wouldEmptyWorkspace(0)).toBe(true);
    expect(wouldEmptyWorkspace(1)).toBe(true);
    expect(wouldEmptyWorkspace(2)).toBe(false);
    expect(LAST_BOT_ERROR).toMatch(/last bot/i);
  });

  it("finds @mentions by longest visible name", () => {
    const peers = [
      { name: "Max", hidden: false },
      { name: "Max Power", hidden: false },
      { name: "Ghost", hidden: true },
    ];
    expect(mentionedBots("ask @Max Power and @Ghost", peers).map((p) => p.name)).toEqual(["Max Power"]);
  });
});
