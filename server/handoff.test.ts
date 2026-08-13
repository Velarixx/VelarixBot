import { describe, expect, it } from "vitest";

import { HANDOFF_CONTINUE, HANDOFF_TITLE, isCredentialAsk, sanitizeHandoffSummary } from "./handoff.ts";

describe("credential handoff copy", () => {
  it("detects sign-in asks and keeps secrets out of the card", () => {
    expect(isCredentialAsk("credential", "browser", "Sign in to GitHub")).toBe(true);
    expect(isCredentialAsk("ask", "shell", "ls")).toBe(false);
    const dirty = sanitizeHandoffSummary("password: hunter2 and token: sk-secret-value");
    expect(dirty).not.toContain("hunter2");
    expect(dirty).not.toContain("sk-secret-value");
    expect(HANDOFF_TITLE).toBe("Bot needs you to sign in");
    expect(HANDOFF_CONTINUE).toContain("signed in");
  });
});
