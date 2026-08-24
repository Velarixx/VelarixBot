import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const settings = readFileSync(join(HERE, "SettingsPanel.tsx"), "utf8");
const appSettings = readFileSync(join(HERE, "AppSettingsPanel.tsx"), "utf8");
const keys = readFileSync(join(HERE, "ApiKeys.tsx"), "utf8");

describe("Settings Apps card stays on the same hub model", () => {
  it("uses the shared enable helper and deep-links into the hub — no second connect flow", () => {
    expect(settings).toContain("toggleEnabledApp");
    expect(settings).toContain("enabledAppSlugs");
    expect(settings).toContain("togglePlugins");
    expect(settings).toContain("Open Apps");
    expect(settings).toContain("CONNECTOR_PATHS.catalog");
    expect(settings).not.toContain("/authorize");
    expect(settings).not.toContain("/api/connectors/");
    expect(settings).not.toMatch(/mcpServers/);
  });

  it("exposes full-autonomy as an explicit persisted setting", () => {
    expect(settings).toContain('aria-label="Full autonomy"');
    expect(settings).toContain("patch({ fullAutonomy: !bot.fullAutonomy })");
    expect(settings).toMatch(/Off by default/);
    expect(settings).toMatch(/Safety-sensitive actions still respect/);
  });

  it("does not change P0.1 Always allow copy or behavior", () => {
    expect(settings).toContain('aria-label="Always allow"');
    expect(settings).toMatch(/Let this bot do routine reads, writes, tool calls, and connected-app actions without/);
    expect(settings).toContain("Only this bot — never workspace-wide");
    expect(settings).toContain("patch({ alwaysAllow: !bot.alwaysAllow })");
  });

  it("App Settings exposes per-engine CLI path via PATCH /api/instances/:id", () => {
    expect(appSettings).toContain("Engine CLIs");
    expect(appSettings).toContain("/api/instances/");
    expect(appSettings).toContain('method: "PATCH"');
    expect(appSettings).toContain("encodeURIComponent(instance.instanceId)");
    expect(appSettings).not.toContain("bot.cli");
  });

  it("App Settings only links to the hub and keeps keys write-only", () => {
    expect(appSettings).toContain("togglePlugins");
    expect(appSettings).toContain("Manage apps");
    expect(keys).toContain('type="password"');
    expect(keys).toContain("configured");
    expect(keys).not.toMatch(/apiKeyConfigured.*value/);
  });

  it("backup copy states every covered domain and withholds Verified unless complete", () => {
    expect(appSettings).toContain("approval rules");
    expect(appSettings).toContain("skills");
    expect(appSettings).toContain("memory notes");
    expect(appSettings).toContain("config.json");
    expect(appSettings).toContain("secrets.json");
    expect(appSettings).toContain("Verified backup saved to");
    expect(appSettings).toContain("complete");
    expect(appSettings).toContain("not a verified archive");
    expect(appSettings).toContain("Back up now");
  });
});
