import { describe, expect, it } from "vitest";

import { HANDOFF_CONTINUE, HANDOFF_TITLE, sanitizeHandoffSummary } from "./handoff.ts";

describe("credential handoff copy", () => {
  it("keeps secrets out of the card", () => {
    const dirty = sanitizeHandoffSummary("password: hunter2 and token: sk-secret-value");
    expect(dirty).not.toContain("hunter2");
    expect(dirty).not.toContain("sk-secret-value");
    expect(HANDOFF_TITLE).toBe("Bot needs you to sign in");
    expect(HANDOFF_CONTINUE).toContain("signed in");
  });
});
