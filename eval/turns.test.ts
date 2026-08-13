import { describe, expect, it } from "vitest";

import { maxTurns } from "./turns.mjs";

describe("TIER_B_MAX_TURNS spend cap", () => {
  it("defaults to 40 when the var is missing or blank", () => {
    expect(maxTurns({})).toBe(40);
    expect(maxTurns({ TIER_B_MAX_TURNS: "" })).toBe(40);
    expect(maxTurns({ TIER_B_MAX_TURNS: "   " })).toBe(40);
  });

  it("honors a positive integer from the repo var", () => {
    expect(maxTurns({ TIER_B_MAX_TURNS: "40" })).toBe(40);
    expect(maxTurns({ TIER_B_MAX_TURNS: "12" })).toBe(12);
  });

  it("falls back to 40 on garbage instead of running unbounded", () => {
    expect(maxTurns({ TIER_B_MAX_TURNS: "nope" })).toBe(40);
    expect(maxTurns({ TIER_B_MAX_TURNS: "0" })).toBe(40);
    expect(maxTurns({ TIER_B_MAX_TURNS: "-3" })).toBe(40);
  });
});
