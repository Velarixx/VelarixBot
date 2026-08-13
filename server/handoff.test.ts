import { describe, expect, it } from "vitest";

import {
  HANDOFF_CONTINUE,
  HANDOFF_SUBTITLE,
  HANDOFF_SUBTITLE_LOCAL,
  HANDOFF_TITLE,
  classifyOpenedRequest,
  handoffSubtitle,
  isCredentialAsk,
  sanitizeHandoffSummary,
  shouldOfferDesktop,
} from "./handoff.ts";

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

  it("classifies CLI permission/question asks as credential without a Box", () => {
    const opened = classifyOpenedRequest("question", "ask_user", "Sign in to GitHub. password: hunter2");
    expect(opened.requestType).toBe("credential");
    expect(opened.choices).toEqual([HANDOFF_CONTINUE]);
    expect(opened.summary).not.toContain("hunter2");
    expect(classifyOpenedRequest("permission", "Bash", "ls").requestType).toBe("permission");
  });

  it("skips Open desktop unless this bot has a configured cloud box", () => {
    expect(shouldOfferDesktop("cloud", true)).toBe(true);
    expect(shouldOfferDesktop("cloud", false)).toBe(false);
    expect(shouldOfferDesktop("local", true)).toBe(false);
    expect(shouldOfferDesktop("off", true)).toBe(false);
    expect(shouldOfferDesktop(undefined, true)).toBe(false);
    expect(handoffSubtitle("cloud")).toBe(HANDOFF_SUBTITLE);
    expect(handoffSubtitle("local")).toBe(HANDOFF_SUBTITLE_LOCAL);
    expect(handoffSubtitle("off")).toBe(HANDOFF_SUBTITLE_LOCAL);
  });
});
