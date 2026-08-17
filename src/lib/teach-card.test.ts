import { describe, expect, it } from "vitest";

import { teachCardPhase, teachPrimaryLabel, teachShowsEditor, teachShowsSaveDiscard } from "./teach-card";

describe("teach card copy", () => {
  it("keeps Stop separate from Save and never says Stop and save skill", () => {
    expect(teachPrimaryLabel("recording")).toBe("Stop");
    expect(teachPrimaryLabel("idle")).toBe("Start recording");
    expect(teachPrimaryLabel("saved")).toBe("Start recording");
    expect(teachPrimaryLabel("draft")).toBeNull();
    expect(teachShowsSaveDiscard("draft")).toBe(true);
    expect(teachShowsSaveDiscard("recording")).toBe(false);
    expect(teachShowsEditor("draft")).toBe(true);
    expect(teachShowsEditor("saved")).toBe(true);
    for (const phase of ["idle", "recording", "draft", "saved"] as const) {
      expect(teachPrimaryLabel(phase) ?? "").not.toMatch(/stop and save/i);
    }
  });

  it("maps recording / draft / saved without collapsing stop into save", () => {
    expect(teachCardPhase({ recording: true, hasDraft: false, hasSaved: false })).toBe("recording");
    expect(teachCardPhase({ recording: false, hasDraft: true, hasSaved: false })).toBe("draft");
    expect(teachCardPhase({ recording: false, hasDraft: false, hasSaved: true })).toBe("saved");
    expect(teachCardPhase({ recording: false, hasDraft: false, hasSaved: false })).toBe("idle");
  });
});
