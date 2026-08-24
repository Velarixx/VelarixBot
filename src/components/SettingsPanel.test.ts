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

  it("App Settings connects Discord with a write-only token, allowlists, bot/group binding, and disconnect", () => {
    expect(appSettings).toContain("DiscordSettings");
    const discord = readFileSync(join(HERE, "DiscordSettings.tsx"), "utf8");
    expect(discord).toContain('section="discord"');
    expect(keys).toContain("discord: { token: v }");
    expect(keys).toContain('type="password"');
    expect(discord).toContain("Connect Discord");
    expect(discord).toContain("Disconnect Discord");
    expect(discord).toContain("Discord agent");
    expect(discord).toContain("Discord group");
    expect(discord).toContain("allowlist");
    expect(discord).toContain("discordDisplayedStatus");
    expect(discord).toContain("discord-next-step");
    expect(discord).not.toMatch(/state\.config\?\.discord\.token/);
  });

  it("App Settings connects Telegram with a write-only token, agent picker, allowlist, and disconnect", () => {
    expect(appSettings).toContain("TelegramSettings");
    const telegram = readFileSync(join(HERE, "TelegramSettings.tsx"), "utf8");
    expect(telegram).toContain('section="telegram"');
    expect(keys).toContain("telegram: { token: v }");
    expect(keys).toContain('type="password"');
    expect(telegram).toContain("Enable Telegram");
    expect(telegram).toContain("Disconnect Telegram");
    expect(telegram).toContain("Telegram agent");
    expect(telegram).toContain("allowlist");
    expect(telegram).toContain("telegramDisplayedStatus");
    expect(telegram).not.toMatch(/state\.config\?\.telegram\.token/);
  });

  it("App Settings only links to the hub and keeps keys write-only", () => {
    expect(appSettings).toContain("togglePlugins");
    expect(appSettings).toContain("Manage apps");
    expect(keys).toContain('type="password"');
    expect(keys).toContain("configured");
    expect(keys).not.toMatch(/apiKeyConfigured.*value/);
  });

  it("exposes Bitwarden Secrets Manager in App Settings and a per-bot allowlist", () => {
    expect(appSettings).toContain("Bitwarden Secrets Manager");
    expect(appSettings).toContain("BITWARDEN_PATHS");
    expect(appSettings).toContain("Disconnect");
    expect(keys).toContain("bitwarden");
    expect(keys).toContain("accessToken");
    expect(settings).toContain("Bitwarden secrets this bot may use");
    expect(settings).toContain("bitwardenSecretIds");
    expect(settings).toContain("bitwardenProjectIds");
    expect(settings).toContain("Default is none");
    expect(settings).not.toMatch(/bitwarden.*value/i);
  });

  it("App Settings shows local usage totals as counts only — not billed amounts or secrets", () => {
    expect(appSettings).toContain("Local usage");
    expect(appSettings).toContain("/api/usage");
    expect(appSettings).toContain("local activity records, not a provider invoice");
    expect(appSettings).toContain("Provider");
    expect(appSettings).toContain("Requests");
    expect(appSettings).toContain("Tokens");
    expect(appSettings).not.toMatch(/Sentry|DSN/);
    expect(appSettings).not.toMatch(/apiKey|secret:\/\//);
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
