import { describe, expect, it } from "vitest";

import { FALLBACK_CODEX_MODELS, labelForCodexModel, parseCodexModelCatalog } from "./codex-models.ts";
import { CodexDriver } from "./codex.ts";

const OLD_HARDCODED = ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.4"];

describe("Codex fallback model catalog", () => {
  it("is not the old three-item hardcoded picker set", () => {
    const ids = CodexDriver.models.options.map((o) => o.id);
    expect(ids).toEqual(FALLBACK_CODEX_MODELS.options.map((o) => o.id));
    expect(ids).not.toEqual(OLD_HARDCODED);
    expect(ids.length).toBeGreaterThan(3);
    expect(ids).toEqual(expect.arrayContaining(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.4"]));
    expect(CodexDriver.models.default).toBe("gpt-5.6-sol");
  });

  it("keeps human labels for Sol / Terra / Luna / 5.4", () => {
    expect(labelForCodexModel("gpt-5.6-sol")).toBe("GPT-5.6 Sol");
    expect(labelForCodexModel("gpt-5.6-terra")).toBe("GPT-5.6 Terra");
    expect(labelForCodexModel("gpt-5.6-luna", "GPT-5.6-Luna")).toBe("GPT-5.6 Luna");
    expect(labelForCodexModel("gpt-5.4")).toBe("GPT-5.4");
    expect(labelForCodexModel("gpt-5.4-mini")).toBe("GPT-5.4 Mini");
  });
});

describe("parseCodexModelCatalog", () => {
  it("reads the CLI `{ models: [{ slug, display_name, visibility }] }` dump", () => {
    const catalog = parseCodexModelCatalog(
      JSON.stringify({
        models: [
          { slug: "gpt-5.6-sol", display_name: "GPT-5.6-Sol", visibility: "list" },
          { slug: "gpt-5.6-terra", display_name: "GPT-5.6-Terra", visibility: "list" },
          { slug: "gpt-5.6-luna", display_name: "GPT-5.6-Luna", visibility: "list" },
          { slug: "gpt-5.5", display_name: "GPT-5.5", visibility: "list" },
          { slug: "gpt-5.4", display_name: "GPT-5.4", visibility: "hide" },
          { slug: "codex-auto-review", display_name: "Codex Auto Review", visibility: "hide" },
        ],
      }),
    );
    expect(catalog?.default).toBe("gpt-5.6-sol");
    expect(catalog?.options.map((o) => o.id)).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
      "gpt-5.4",
    ]);
    expect(catalog?.options.map((o) => o.label)).toEqual([
      "GPT-5.6 Sol",
      "GPT-5.6 Terra",
      "GPT-5.6 Luna",
      "GPT-5.5",
      "GPT-5.4",
    ]);
  });

  it("accepts a bare array and `id` instead of `slug`", () => {
    const catalog = parseCodexModelCatalog(JSON.stringify([{ id: "gpt-5.6-luna", display_name: "GPT-5.6-Luna" }]));
    expect(catalog).toEqual({
      default: "gpt-5.6-luna",
      options: [{ id: "gpt-5.6-luna", label: "GPT-5.6 Luna" }],
    });
  });

  it("returns null for empty or invalid dumps so the driver can fall back", () => {
    expect(parseCodexModelCatalog("")).toBeNull();
    expect(parseCodexModelCatalog("not json")).toBeNull();
    expect(parseCodexModelCatalog(JSON.stringify({ models: [] }))).toBeNull();
    expect(parseCodexModelCatalog(JSON.stringify({ models: [{ visibility: "list" }] }))).toBeNull();
  });
});
