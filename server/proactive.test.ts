import { describe, expect, it } from "vitest";

import { createProactive } from "./proactive.ts";

describe("proactive stall nudge", () => {
  it("fires exactly one nudge after N hours, and stays at one", () => {
    let now = 0;
    const nudges: string[] = [];
    const triggers: Array<{ botId: string; prompt: string }> = [];
    const p = createProactive({
      now: () => now,
      stallMs: 2 * 60 * 60 * 1000,
      onNudge: (botId) => nudges.push(botId),
      onTrigger: (botId, prompt) => triggers.push({ botId, prompt }),
    });

    p.noteState("bot-a", "NEEDS_INPUT");
    now = 2 * 60 * 60 * 1000 - 1;
    p.tick();
    expect(nudges).toEqual([]);

    now = 2 * 60 * 60 * 1000;
    p.tick();
    p.tick();
    p.tick();
    expect(nudges).toEqual(["bot-a"]);
  });

  it("resets on answer / new turn / dismiss so a later stall can nudge once more", () => {
    let now = 0;
    const nudges: string[] = [];
    const p = createProactive({
      now: () => now,
      stallMs: 1_000,
      onNudge: (id) => nudges.push(id),
      onTrigger: () => {},
    });
    p.noteState("bot-a", "BLOCKED");
    now = 1_000;
    p.tick();
    expect(nudges).toEqual(["bot-a"]);

    p.reset("bot-a");
    p.noteState("bot-a", "NEEDS_INPUT");
    now = 2_000;
    p.tick();
    expect(nudges).toEqual(["bot-a", "bot-a"]);
  });

  it("does not nudge IDLE / RUNNING / DONE", () => {
    let now = 0;
    const nudges: string[] = [];
    const p = createProactive({
      now: () => now,
      stallMs: 1,
      onNudge: (id) => nudges.push(id),
      onTrigger: () => {},
    });
    p.noteState("bot-a", "RUNNING");
    now = 10;
    p.tick();
    p.noteState("bot-a", "DONE");
    p.tick();
    expect(nudges).toEqual([]);
  });
});

describe("routine-complete trigger", () => {
  it("starts exactly one turn on bot B with prompt P", () => {
    const triggers: Array<{ botId: string; prompt: string }> = [];
    const p = createProactive({
      now: () => 0,
      onNudge: () => {},
      onTrigger: (botId, prompt) => triggers.push({ botId, prompt }),
    });
    p.routineCompleted({ botId: "bot-b", prompt: "Follow up on the briefing." });
    expect(triggers).toEqual([{ botId: "bot-b", prompt: "Follow up on the briefing." }]);
    p.routineCompleted(null);
    p.routineCompleted({ botId: "bot-b", prompt: "   " });
    expect(triggers).toHaveLength(1);
  });
});
