import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CONNECTOR_PATHS, enabledAppSlugs, toggleEnabledApp } from "@/lib/apps";

const HERE = dirname(fileURLToPath(import.meta.url));
const hub = readFileSync(join(HERE, "PluginsPanel.tsx"), "utf8");
const sidebar = readFileSync(join(HERE, "Sidebar.tsx"), "utf8");

describe("Apps hub surface", () => {
  it("is the one place with Sessions create/list/revoke, catalog, Connect/Disconnect, and per-bot enable", () => {
    expect(hub).toContain("CONNECTOR_PATHS.catalog");
    expect(hub).toContain("CONNECTOR_PATHS.sessions");
    expect(hub).toContain("CONNECTOR_PATHS.revoke");
    expect(hub).toContain("CONNECTOR_PATHS.status");
    expect(hub).toContain("CONNECTOR_PATHS.authorize");
    expect(hub).toContain("CONNECTOR_PATHS.disconnect");
    expect(hub).toContain("toggleEnabledApp");
    expect(hub).toContain("enabledAppSlugs");
    expect(hub).toContain("sessionUserId");
    expect(hub).toContain('role="switch"');
    expect(hub).toContain("Connect");
    expect(hub).toContain("Disconnect");
    expect(hub).toContain("Create session");
    expect(hub).toContain("Revoke");
    expect(hub).toContain("hubUnconfiguredCopy");
    expect(hub).toContain("connectorHealthLabel");
    expect(hub).toContain("data-next-step");
    expect(hub).toContain("data-connector-health");
    expect(hub).toContain("Next step:");
  });

  it("does not become a custom MCP store or expose connection management to a bot", () => {
    expect(hub).not.toMatch(/mcpServers/);
    expect(hub).not.toMatch(/COMPOSIO_MANAGE/);
    expect(hub).not.toMatch(/command:\s*["']npx/);
    expect(hub).not.toMatch(/type=["']url["']/);
    expect(sidebar).not.toMatch(/MCP servers over stdio/i);
    expect(sidebar).toContain(">Apps<");
  });
});

describe("hub actions hit the existing routes", () => {
  it("connect/disconnect use /api/connectors/* and enable PATCHes only the selected bot", () => {
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    const request = (path: string, init?: RequestInit) => {
      calls.push({ path, init });
      return Promise.resolve({});
    };

    void request(CONNECTOR_PATHS.catalog);
    void request(CONNECTOR_PATHS.sessions);
    void request(CONNECTOR_PATHS.status(["gmail"], "bot-a"));
    void request(CONNECTOR_PATHS.authorize("gmail", "bot-a"), { method: "POST" });
    void request(CONNECTOR_PATHS.disconnect("gmail", "bot-a"), { method: "DELETE" });
    void request(CONNECTOR_PATHS.sessions, { method: "POST", body: JSON.stringify({ botId: "bot-a" }) });
    void request(CONNECTOR_PATHS.revoke("sess-1"), { method: "DELETE" });

    const selected = { id: "bot-a", enabledApps: [] as string[] };
    const other = { id: "bot-b", enabledApps: ["slack"] };
    const next = toggleEnabledApp(enabledAppSlugs(selected), "gmail");
    void request(CONNECTOR_PATHS.bot(selected.id), {
      method: "PATCH",
      body: JSON.stringify({ enabledApps: next }),
    });

    expect(calls.map((c) => [c.path, c.init?.method])).toEqual([
      ["/api/connectors/catalog", undefined],
      ["/api/connectors/sessions", undefined],
      ["/api/connectors?services=gmail&botId=bot-a", undefined],
      ["/api/connectors/gmail/authorize?botId=bot-a", "POST"],
      ["/api/connectors/gmail?botId=bot-a", "DELETE"],
      ["/api/connectors/sessions", "POST"],
      ["/api/connectors/sessions/sess-1", "DELETE"],
      ["/api/bots/bot-a", "PATCH"],
    ]);
    expect(JSON.parse(String(calls[7]?.init?.body))).toEqual({ enabledApps: ["gmail"] });
    expect(other.enabledApps).toEqual(["slack"]);
    expect(enabledAppSlugs(selected)).toEqual([]);
  });
});
