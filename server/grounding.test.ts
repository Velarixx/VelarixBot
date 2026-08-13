import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { CHAT_ONLY_GROUNDING, CODEX_GROUNDING, turnGrounding } from "./grounding.ts";

const indexSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.ts"), "utf8");

describe("turnGrounding", () => {
  it("always grounds Codex, including when agents MCP is not mounted", () => {
    expect(turnGrounding("codex")).toBe(CODEX_GROUNDING);
    expect(CODEX_GROUNDING).toMatch(/in-app browser/i);
    expect(CODEX_GROUNDING).toMatch(/web_search/);
    expect(CODEX_GROUNDING).toMatch(/fetch_page/);
    expect(CODEX_GROUNDING).toMatch(/create_bot/);
    expect(CODEX_GROUNDING).toMatch(/update_bot/);
    expect(CODEX_GROUNDING).toMatch(/shell|PowerShell/i);
  });

  it("tells chat-only drivers they have no tools", () => {
    for (const kind of ["openrouter", "omnirouter", "grok"]) {
      expect(turnGrounding(kind)).toBe(CHAT_ONLY_GROUNDING);
    }
    expect(CHAT_ONLY_GROUNDING).toMatch(/no tools/i);
  });

  it("does not attach chat-only or Codex lines to tool-capable CLI drivers", () => {
    expect(turnGrounding("claudeAgent")).toBe("");
    expect(turnGrounding("grokAgent")).toBe("");
    expect(turnGrounding("geminiAgent")).toBe("");
    expect(turnGrounding("boxAgent")).toBe("");
  });

  it("is appended on every harness turn, not only when agents MCP mounts", () => {
    expect(indexSrc).toMatch(/memoryPrompt\(bot\.id\)\s*\+\s*turnGrounding\(instance\.driverKind\)/);
    expect(indexSrc).toContain("cwd: ensureBotWorkspace(bot.id)");
  });
});
