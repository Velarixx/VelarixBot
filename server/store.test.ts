// Domain-model helpers: normalization, schedules, product rules. The
// persistence behaviors that used to live here moved with the data to
// server/repositories/*.test.ts and server/services/services.test.ts.
import { describe, expect, it } from "vitest";

import {
  LAST_BOT_ERROR,
  mentionedBots,
  nextRunAt,
  enabledSkillIds,
  normalizeBot,
  normalizeRoutine,
  parseMissedPolicy,
  parseRoutineSchedule,
  listenerFilterComplete,
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

  it("rejects only truly unrecognizable records (no id/threadId)", () => {
    expect(normalizeBot(null)).toBeNull();
    expect(normalizeBot({ id: "x" })).toBeNull();
    expect(normalizeBot({ threadId: "t" })).toBeNull();
    expect(normalizeBot({ ...baseBot, id: "" })).toBeNull();
  });

  it("salvages a damaged record instead of vanishing it (rc.14 field regression)", () => {
    // one bad field must never make the bot disappear from every read —
    // the field trace was list_bots "No other bots" + update_bot "no such
    // bot" while the row still existed
    const badSelection = normalizeBot({ ...baseBot, modelSelection: {} });
    expect(badSelection).toMatchObject({ id: "bot-1", threadId: "thread-1", name: "Testy", modelSelection: { instanceId: "", model: "" } });
    const stringSelection = normalizeBot({ ...baseBot, modelSelection: "gpt-5.6-terra" } as unknown as Partial<BotRecord>);
    expect(stringSelection?.modelSelection).toEqual({ instanceId: "", model: "" });
    const badName = normalizeBot({ ...baseBot, name: 123 } as unknown as Partial<BotRecord>);
    expect(badName).toMatchObject({ id: "bot-1", name: "New Bot", modelSelection: baseBot.modelSelection });
  });

  it("keeps the per-bot Always allow flag only when explicitly true", () => {
    expect(normalizeBot({ ...baseBot, alwaysAllow: true })?.alwaysAllow).toBe(true);
    expect(normalizeBot({ ...baseBot, alwaysAllow: "yes" } as unknown as Partial<BotRecord>)?.alwaysAllow).toBeUndefined();
    expect(normalizeBot(baseBot)?.alwaysAllow).toBeUndefined();
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
      enabledSkills: ["skill-a", "", "skill-b"],
      threadParticipants: ["a", "b"],
    } as unknown as Partial<BotRecord>);
    expect(bot?.notifyEvents).toEqual({ "peer.reply": false });
    expect(bot?.enabledApps).toEqual(["googledrive", "42"]);
    expect(bot?.enabledSkills).toEqual(["skill-a", "skill-b"]);
    expect(bot?.threadParticipants).toEqual(["a", "b"]);
  });

  it("legacy skillId becomes the enabled set when enabledSkills is empty", () => {
    expect(enabledSkillIds({ skillId: "a" })).toEqual(["a"]);
    expect(enabledSkillIds({ skillId: "a", enabledSkills: [] })).toEqual(["a"]);
    expect(enabledSkillIds({ skillId: "a", enabledSkills: ["b", "c"] })).toEqual(["b", "c"]);
    expect(enabledSkillIds({ enabledSkills: ["x", "x", "y"] })).toEqual(["x", "y"]);
    expect(enabledSkillIds({})).toEqual([]);
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
    expect(
      parseRoutineSchedule({
        kind: "listener",
        source: "github",
        repo: "Velarixx/VelarixBot",
        events: ["pull_request", "issues", "*", "push"],
      }),
    ).toEqual({
      kind: "listener",
      source: "github",
      everyMinutes: 15,
      repo: { owner: "Velarixx", name: "VelarixBot" },
      events: ["pull_request", "issues", "push"],
    });
    expect(
      parseRoutineSchedule({ kind: "listener", source: "slack", channel: "#eng", match: "keyword", keyword: "deploy" }),
    ).toEqual({
      kind: "listener",
      source: "slack",
      everyMinutes: 15,
      channel: "#eng",
      match: "keyword",
      keyword: "deploy",
    });
  });

  it("rejects invalid schedules", () => {
    expect(() => parseRoutineSchedule({ kind: "interval", everyMinutes: 0 })).toThrow();
    expect(() => parseRoutineSchedule({ kind: "daily", time: "25:00" })).toThrow();
    expect(() => parseRoutineSchedule({ kind: "listener", source: "discord" })).toThrow(/github or slack/);
    expect(() => parseRoutineSchedule({ kind: "listener", source: "github" }, { strictListener: true })).toThrow(/owner\/name/);
    expect(() =>
      parseRoutineSchedule({ kind: "listener", source: "github", repo: "*/*", events: ["push"] }, { strictListener: true }),
    ).toThrow(/owner\/name/);
    expect(() =>
      parseRoutineSchedule({ kind: "listener", source: "slack", channel: "*", match: "message" }, { strictListener: true }),
    ).toThrow(/channel or DM/);
  });

  it("weekdays schedules skip the weekend", () => {
    const saturday = new Date(2026, 7, 15, 10, 0, 0).getTime();
    const next = nextRunAt({ kind: "weekdays", time: "09:00" }, saturday);
    expect(new Date(next).getDay()).toBe(1);
    expect(nextRunAt({ kind: "listener", source: "github", everyMinutes: 15 }, 1_000)).toBe(1_000 + 15 * 60_000);
    expect(listenerFilterComplete({ kind: "listener", source: "github", everyMinutes: 15 })).toBe(false);
    expect(
      listenerFilterComplete({
        kind: "listener",
        source: "github",
        repo: { owner: "Velarixx", name: "VelarixBot" },
        events: ["push"],
      }),
    ).toBe(true);
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
    expect(routine).toMatchObject({ running: false, nextRunAt: 42, enabled: true, lastRunAt: null, missedPolicy: "run-once" });
    expect(normalizeRoutine({ id: "r1" })).toBeNull();
  });

  it("normalizes the missed policy and defaults unknown values to run-once", () => {
    const base = { id: "r1", botId: "b1", name: "R", prompt: "P", schedule: { kind: "interval", everyMinutes: 5 }, nextRunAt: 42 };
    expect(normalizeRoutine({ ...base, missedPolicy: "catch-up" })?.missedPolicy).toBe("catch-up");
    expect(normalizeRoutine({ ...base, missedPolicy: "skip" })?.missedPolicy).toBe("skip");
    expect(normalizeRoutine({ ...base, missedPolicy: "bogus" })?.missedPolicy).toBe("run-once");
    expect(parseMissedPolicy("run-once")).toBe("run-once");
    expect(parseMissedPolicy("whenever")).toBeNull();
  });
});

describe("timezone-explicit clock schedules", () => {
  it("round-trips a valid zone and rejects or drops a bad one by strictness", () => {
    expect(parseRoutineSchedule({ kind: "daily", time: "09:30", timeZone: "Europe/Berlin" })).toEqual({
      kind: "daily",
      time: "09:30",
      timeZone: "Europe/Berlin",
    });
    // lenient (loading a stored record): an unknown zone degrades to local
    expect(parseRoutineSchedule({ kind: "daily", time: "09:30", timeZone: "Mars/Olympus" })).toEqual({ kind: "daily", time: "09:30" });
    // strict (create/edit): an unknown zone is an error
    expect(() => parseRoutineSchedule({ kind: "daily", time: "09:30", timeZone: "Mars/Olympus" }, { strictTimeZone: true })).toThrow(
      /invalid time zone/,
    );
  });

  it("computes occurrences by the stored zone's wall clock, not the host's", () => {
    // 2026-01-15 12:00Z: 09:00 in New York is 14:00Z (EST, UTC-5) and still
    // ahead today; 09:00 in Tokyo already passed, so it lands tomorrow —
    // true in any host zone the test happens to run in
    const from = Date.UTC(2026, 0, 15, 12, 0);
    expect(nextRunAt({ kind: "daily", time: "09:00", timeZone: "America/New_York" }, from)).toBe(Date.UTC(2026, 0, 15, 14, 0));
    expect(nextRunAt({ kind: "daily", time: "09:00", timeZone: "Asia/Tokyo" }, from)).toBe(Date.UTC(2026, 0, 16, 0, 0));
  });

  it("keeps the wall time stable across a DST transition (23h/25h days)", () => {
    // Europe/Berlin springs forward 2026-03-29: 09:00 CET (08:00Z) on the
    // 28th, then 09:00 CEST (07:00Z) on the 29th — a 23-hour gap
    const beforeSpring = Date.UTC(2026, 2, 28, 9, 0); // 10:00 Berlin
    const first = nextRunAt({ kind: "daily", time: "09:00", timeZone: "Europe/Berlin" }, beforeSpring);
    const second = nextRunAt({ kind: "daily", time: "09:00", timeZone: "Europe/Berlin" }, first);
    expect(first).toBe(Date.UTC(2026, 2, 29, 7, 0));
    expect(first - beforeSpring).toBe(22 * 3_600_000);
    // Berlin falls back 2026-10-25: the day is 25 hours long
    const beforeFall = nextRunAt({ kind: "daily", time: "09:00", timeZone: "Europe/Berlin" }, Date.UTC(2026, 9, 24, 6, 0));
    const afterFall = nextRunAt({ kind: "daily", time: "09:00", timeZone: "Europe/Berlin" }, beforeFall);
    expect(beforeFall).toBe(Date.UTC(2026, 9, 24, 7, 0)); // CEST
    expect(afterFall).toBe(Date.UTC(2026, 9, 25, 8, 0)); // CET
    expect(afterFall - beforeFall).toBe(25 * 3_600_000);
    expect(second - first).toBe(24 * 3_600_000);
  });

  it("resolves a spring-forward gap to the first instant after it", () => {
    // America/New_York 2026-03-08: 02:00–03:00 EST never happens. A 02:30
    // schedule runs at 03:00 EDT (07:00Z), the first instant past the gap.
    const from = Date.UTC(2026, 2, 8, 5, 0); // 00:00 EST that night
    expect(nextRunAt({ kind: "daily", time: "02:30", timeZone: "America/New_York" }, from)).toBe(Date.UTC(2026, 2, 8, 7, 0));
  });

  it("resolves a fall-back repeat to the earlier instant", () => {
    // America/New_York 2026-11-01: 01:30 happens twice (EDT 05:30Z, then
    // EST 06:30Z). The schedule fires once, at the earlier instant.
    const from = Date.UTC(2026, 10, 1, 4, 0); // 00:00 EDT that night
    expect(nextRunAt({ kind: "daily", time: "01:30", timeZone: "America/New_York" }, from)).toBe(Date.UTC(2026, 10, 1, 5, 30));
  });

  it("weekdays follow the zone's calendar, not the host's", () => {
    // 2026-08-14 23:00 UTC is Friday in UTC but already Saturday 11:00 in
    // Auckland — the next Auckland weekday 09:00 is Monday the 17th (NZST,
    // UTC+12): 2026-08-16 21:00Z
    const from = Date.UTC(2026, 7, 14, 23, 0);
    expect(nextRunAt({ kind: "weekdays", time: "09:00", timeZone: "Pacific/Auckland" }, from)).toBe(Date.UTC(2026, 7, 16, 21, 0));
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
