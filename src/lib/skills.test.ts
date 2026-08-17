import { describe, expect, it } from "vitest";
import { enabledSkillIds, toggleSkillId } from "./skills";

describe("enabledSkillIds", () => {
  it("treats a legacy skillId as the enabled set when the array is empty", () => {
    expect(enabledSkillIds({ skillId: "a" })).toEqual(["a"]);
    expect(enabledSkillIds({ skillId: "a", enabledSkills: [] })).toEqual(["a"]);
  });

  it("uses the enabled array when it has ids", () => {
    expect(enabledSkillIds({ skillId: "a", enabledSkills: ["b", "c"] })).toEqual(["b", "c"]);
    expect(enabledSkillIds({ enabledSkills: ["x", "x", "y"] })).toEqual(["x", "y"]);
  });
});

describe("toggleSkillId", () => {
  it("adds and removes without clobbering the rest of the set", () => {
    expect(toggleSkillId(["a"], "b")).toEqual(["a", "b"]);
    expect(toggleSkillId(["a", "b"], "a")).toEqual(["b"]);
  });
});
