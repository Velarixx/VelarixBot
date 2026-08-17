import { describe, expect, it } from "vitest";
import {
  appendStreamingResponseText,
  parseResponseOptions,
  responseOptionsPrompt,
  shouldAttachResponseOptions,
  visibleStreamingResponseText,
} from "./response-options.ts";

describe("response options", () => {
  it("extracts contextual choices without showing the transport marker", () => {
    expect(
      parseResponseOptions(
        'The report is ready.\n\n<velarix_options>["Open the report","Summarize the risks","Draft an email"]</velarix_options>',
      ),
    ).toEqual({
      text: "The report is ready.",
      options: ["Open the report", "Summarize the risks", "Draft an email"],
    });
  });

  it("limits, trims, and deduplicates choices", () => {
    expect(
      parseResponseOptions(
        '<velarix_options>["  Continue  ","Continue","Compare alternatives","Show details","Extra"]</velarix_options>',
      ).options,
    ).toEqual(["Continue", "Compare alternatives", "Show details", "Extra"]);
  });

  it("shows no next-step cards when a reply has no trailer", () => {
    expect(parseResponseOptions("The migration reduced startup time by 40%.")).toEqual({
      text: "The migration reduced startup time by 40%.",
      options: [],
    });
  });

  it("does not invent fallback cards for a short correction or acknowledgement", () => {
    expect(parseResponseOptions("You're right.")).toEqual({ text: "You're right.", options: [] });
    expect(parseResponseOptions("Done.")).toEqual({ text: "Done.", options: [] });
  });

  it("does not invent fallback cards when the user asked to stop suggesting", () => {
    expect(parseResponseOptions("I'll stop suggesting next steps.")).toEqual({
      text: "I'll stop suggesting next steps.",
      options: [],
    });
  });

  it("does not invent fallback cards from a malformed or singleton trailer", () => {
    expect(parseResponseOptions("The migration is ready.\n<velarix_options>not-json</velarix_options>")).toEqual({
      text: "The migration is ready.",
      options: [],
    });
    expect(parseResponseOptions('Ready.\n<velarix_options>["Only one"]</velarix_options>')).toEqual({
      text: "Ready.",
      options: [],
    });
  });

  it("does not treat an ordinary sentence as Explain/Verify/Next-step labels", () => {
    const text =
      "The deployment completed with database migrations, cache warming, health checks, and traffic validation all successful.";
    expect(parseResponseOptions(text)).toEqual({ text, options: [] });
  });

  it("keeps the option format optional — never required every turn", () => {
    expect(responseOptionsPrompt.toLowerCase()).toContain("you may offer");
    expect(responseOptionsPrompt).toContain("<velarix_options>");
    expect(responseOptionsPrompt.toLowerCase()).not.toContain("end every");
    expect(responseOptionsPrompt.toLowerCase()).not.toMatch(/every user-facing reply/);
  });

  it("does not attach post-turn A/B/C cards for Codex", () => {
    expect(shouldAttachResponseOptions("codex")).toBe(false);
    expect(shouldAttachResponseOptions("claudeAgent")).toBe(true);
    expect(shouldAttachResponseOptions("boxAgent")).toBe(true);
  });

  it("hides partial and complete option markers from streamed text", () => {
    expect(visibleStreamingResponseText("Done.\n\n<velarix_")).toBe("Done.");
    expect(visibleStreamingResponseText('Done.\n\n<velarix_options>["Continue"]')).toBe("Done.");
    expect(visibleStreamingResponseText("Use <tags> in HTML")).toBe("Use <tags> in HTML");
  });

  it("retains hidden raw chunks while keeping the stream projection clean", () => {
    let stream = appendStreamingResponseText("", "Done.\n\n<velarix_");
    expect(stream).toEqual({ raw: "Done.\n\n<velarix_", visible: "Done." });
    stream = appendStreamingResponseText(stream.raw, 'options>["Continue"]</velarix_options>');
    expect(stream.visible).toBe("Done.");
    expect(stream.raw).toContain('options>["Continue"]');
  });
});
