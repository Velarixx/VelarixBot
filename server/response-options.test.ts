import { describe, expect, it } from "vitest";
import {
  appendStreamingResponseText,
  parseResponseOptions,
  responseOptionsPrompt,
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

  it("derives contextual fallback choices when a provider omits the marker", () => {
    expect(parseResponseOptions("The migration reduced startup time by 40%.")).toEqual({
      text: "The migration reduced startup time by 40%.",
      options: [
        "Explain: “The migration reduced startup time by 40%”",
        "Verify: “The migration reduced startup time by 40%”",
        "Next step for: “The migration reduced startup time by 40%”",
      ],
    });
  });

  it("does not expose a malformed transport trailer", () => {
    expect(parseResponseOptions("The migration is ready.\n<velarix_options>not-json</velarix_options>")).toEqual({
      text: "The migration is ready.",
      options: [
        "Explain: “The migration is ready”",
        "Verify: “The migration is ready”",
        "Next step for: “The migration is ready”",
      ],
    });
  });

  it("keeps even minimal completion fallbacks tied to the completed result", () => {
    expect(parseResponseOptions("Done.").options).toEqual([
      "Review the completed result",
      "Verify the completed result",
      "Choose the next step",
    ]);
  });

  it("keeps long fallback labels bounded without losing response context", () => {
    const text = "The deployment completed with database migrations, cache warming, health checks, and traffic validation all successful.";
    const options = parseResponseOptions(text).options;
    expect(options[0]).toContain("The deployment completed with database migrations");
    expect(options.every((option) => option.length <= 92)).toBe(true);
    expect(options.some((option) => option.includes("the response"))).toBe(false);
  });

  it("instructs providers to return a few user-selectable choices", () => {
    expect(responseOptionsPrompt).toContain("2 to 4");
    expect(responseOptionsPrompt).toContain("<velarix_options>");
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
