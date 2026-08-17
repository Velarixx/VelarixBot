import { describe, expect, it } from "vitest";
import {
  filterMentionCandidates,
  mentionableRoutines,
  mentionedRoutines,
  routineSendFromText,
  stripMentions,
} from "./mentions";

const bots = [
  { id: "bot-1", name: "Milind" },
  { id: "bot-2", name: "Scout" },
  { id: "bot-hidden", name: "Ghost", hidden: true },
];

const routines = [
  { id: "r-standup", name: "Standup", botId: "bot-1" },
  { id: "r-hidden", name: "Secret", botId: "bot-hidden" },
  { id: "r-gone", name: "Orphan", botId: "deleted" },
];

describe("mentionableRoutines", () => {
  it("lists non-hidden routines and hides those whose bot is hidden or gone", () => {
    expect(mentionableRoutines(routines, bots).map((r) => r.name)).toEqual(["Standup"]);
  });
});

describe("filterMentionCandidates", () => {
  it("lists bots and runnable routines; labels stay distinct at the call site", () => {
    const hits = filterMentionCandidates("", bots.filter((b) => b.id !== "bot-1" && !b.hidden), mentionableRoutines(routines, bots));
    expect(hits.map((h) => `${h.kind}:${h.name}`)).toEqual(["bot:Scout", "routine:Standup"]);
  });
});

describe("routineSendFromText", () => {
  it("mention-only uses the stored prompt (no override)", () => {
    expect(routineSendFromText("@Standup", routines, bots)).toEqual({ routineId: "r-standup" });
    expect(routineSendFromText("@Standup ", routines, bots)).toEqual({ routineId: "r-standup" });
  });

  it("mention plus extra text uses that text as this run's prompt", () => {
    expect(routineSendFromText("@Standup brief me now", routines, bots)).toEqual({
      routineId: "r-standup",
      prompt: "brief me now",
    });
  });

  it("does not run a hidden bot or a routine for a hidden/deleted bot", () => {
    expect(routineSendFromText("@Secret", routines, bots)).toBeNull();
    expect(routineSendFromText("@Orphan", routines, bots)).toBeNull();
    expect(routineSendFromText("@Ghost", routines, bots)).toBeNull();
  });

  it("leaves @Bot mentions to the existing send / ask_bot path", () => {
    expect(routineSendFromText("@Scout look at this", routines, bots)).toBeNull();
    expect(mentionedRoutines("@Scout look at this", mentionableRoutines(routines, bots))).toEqual([]);
  });
});

describe("stripMentions", () => {
  it("removes the @name token and keeps the rest", () => {
    expect(stripMentions("@Standup brief me now", ["Standup"])).toBe("brief me now");
  });
});
