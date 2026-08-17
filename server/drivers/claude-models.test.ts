import { describe, expect, it } from "vitest";

import { FALLBACK_CLAUDE_MODELS, parseClaudeModelCatalog } from "./claude-models.ts";

describe("parseClaudeModelCatalog", () => {
  it("reads JSON { models: [{ id, display_name }] }", () => {
    const catalog = parseClaudeModelCatalog(
      JSON.stringify({
        models: [
          { id: "claude-sonnet-5", display_name: "Claude Sonnet 5" },
          { id: "claude-opus-5", display_name: "Claude Opus 5" },
        ],
      }),
    );
    expect(catalog).toEqual({
      default: "claude-sonnet-5",
      options: [
        { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
        { id: "claude-opus-5", label: "Claude Opus 5" },
      ],
    });
  });

  it("reads one id per line when JSON is absent", () => {
    const catalog = parseClaudeModelCatalog("claude-haiku-4-5\nclaude-sonnet-5\n");
    expect(catalog?.options.map((o) => o.id)).toEqual(["claude-haiku-4-5", "claude-sonnet-5"]);
    expect(catalog?.default).toBe("claude-sonnet-5");
  });

  it("returns null on empty or unusable stdout so the caller keeps the fallback", () => {
    expect(parseClaudeModelCatalog("")).toBeNull();
    expect(parseClaudeModelCatalog("not a catalog")).toBeNull();
    expect(FALLBACK_CLAUDE_MODELS.options.map((o) => o.id)).toEqual([
      "claude-fable-5",
      "claude-opus-5",
      "claude-sonnet-5",
      "claude-haiku-4-5",
    ]);
  });
});
