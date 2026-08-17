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

  it("App Settings only links to the hub and keeps keys write-only", () => {
    expect(appSettings).toContain("togglePlugins");
    expect(appSettings).toContain("Manage apps");
    expect(keys).toContain('type="password"');
    expect(keys).toContain("configured");
    expect(keys).not.toMatch(/apiKeyConfigured.*value/);
  });
});
