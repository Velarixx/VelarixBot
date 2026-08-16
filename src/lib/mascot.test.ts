// M1 mascot wiring: with no explicit user pin, the face follows the live
// BotState; an explicit pin always wins; the A1 seed-derived expression is
// a resting face, never a pin. Pure functions — no DOM, no timers.
import { describe, expect, it } from "vitest";

import type { BotState } from "@/lib/product";
import { normalizeState, stateForBot, type MascotBotProfile } from "./mascot";

const bot = (over: Partial<MascotBotProfile> = {}): MascotBotProfile => ({
  name: "New Bot",
  ...over,
});

const failedTool = { kind: "activity", tool: { ok: false } };
const optionsCard = { kind: "options" };

describe("stateForBot × BotState (M1)", () => {
  it("maps every live BotState when the user has not pinned a face", () => {
    expect(stateForBot(bot({ state: "RUNNING" }))).toBe("working");
    expect(stateForBot(bot({ state: "DONE" }))).toBe("proud");
    expect(stateForBot(bot({ state: "BLOCKED" }))).toBe("alerting");
    expect(stateForBot(bot({ state: "NEEDS_INPUT" }))).toBe("curious");
    expect(stateForBot(bot({ state: "IDLE" }))).toBe("idle");
  });

  it("BotState beats the message-fold signals — the badge and face agree", () => {
    // DONE bots are often unread; the finish face still shows
    expect(stateForBot(bot({ state: "DONE", unread: true }))).toBe("proud");
    // BLOCKED shows alerting even when the last message is an options card
    expect(stateForBot(bot({ state: "BLOCKED", messages: [optionsCard] }))).toBe("alerting");
    // NEEDS_INPUT is curious even when the ask is not the last message
    expect(stateForBot(bot({ state: "NEEDS_INPUT", messages: [failedTool] }))).toBe("curious");
    // RUNNING wins over a stale failed-activity tail
    expect(stateForBot(bot({ state: "RUNNING", messages: [failedTool] }))).toBe("working");
  });

  it("an explicit user pin wins over every BotState", () => {
    const states: BotState[] = ["IDLE", "RUNNING", "DONE", "BLOCKED", "NEEDS_INPUT"];
    for (const state of states) {
      expect(stateForBot(bot({ state, mascotExpression: "happy", mascotPinned: true }))).toBe("happy");
    }
  });

  it("a legacy record (expression, no pin flag) keeps the historical pin behavior", () => {
    expect(stateForBot(bot({ state: "RUNNING", mascotExpression: "drowsy" }))).toBe("drowsy");
    // legacy vocabulary still normalizes on read
    expect(stateForBot(bot({ state: "DONE", mascotExpression: "friendly" }))).toBe(normalizeState("friendly"));
  });

  it("an A1 seed-derived expression (mascotPinned false) never masks the live BotState", () => {
    expect(stateForBot(bot({ state: "RUNNING", mascotExpression: "drowsy", mascotPinned: false }))).toBe("working");
    expect(stateForBot(bot({ state: "DONE", mascotExpression: "drowsy", mascotPinned: false }))).toBe("proud");
    expect(stateForBot(bot({ state: "BLOCKED", mascotExpression: "drowsy", mascotPinned: false }))).toBe("alerting");
    expect(stateForBot(bot({ state: "NEEDS_INPUT", mascotExpression: "drowsy", mascotPinned: false }))).toBe("curious");
    // …but it is the resting face once the bot is idle and quiet
    expect(stateForBot(bot({ state: "IDLE", mascotExpression: "drowsy", mascotPinned: false }))).toBe("drowsy");
  });

  it("the unpinned seed face yields to active work but wins over passive nudges", () => {
    const seeded = { mascotExpression: "drowsy", mascotPinned: false, state: "IDLE" as const };
    expect(stateForBot(bot({ ...seeded, messages: [failedTool] }))).toBe("alerting");
    expect(stateForBot(bot({ ...seeded, busy: true }))).toBe("working");
    expect(stateForBot(bot({ ...seeded, unread: true }))).toBe("drowsy");
    expect(stateForBot(bot({ ...seeded, messages: [optionsCard] }))).toBe("drowsy");
  });

  it("IDLE bots without any expression keep today's fold and keyword rules", () => {
    expect(stateForBot(bot({ state: "IDLE", messages: [failedTool] }))).toBe("alerting");
    expect(stateForBot(bot({ state: "IDLE", busy: true }))).toBe("working");
    expect(stateForBot(bot({ state: "IDLE", unread: true }))).toBe("notifying");
    expect(stateForBot(bot({ state: "IDLE", messages: [optionsCard] }))).toBe("curious");
    expect(stateForBot(bot({ state: "IDLE", description: "senior software engineer" }))).toBe("working");
    expect(stateForBot(bot({ state: "IDLE", title: "Research strategist" }))).toBe("searching");
  });

  it("callers without a live state (peers, previews) fall through unchanged", () => {
    expect(stateForBot(bot())).toBe("idle");
    expect(stateForBot(bot({ busy: true }))).toBe("working");
    expect(stateForBot(bot({ mascotExpression: "proud", mascotPinned: true }))).toBe("proud");
  });
});
