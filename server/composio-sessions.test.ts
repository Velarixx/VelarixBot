// Composio v3.1 Sessions: fake backend only — no live network, no ck_
// required, secrets stay in env, GET /api/config is booleans only.
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  composioConfigured,
  composioSessionKey,
  createSession,
  revokeSession,
  sessionProxyEnv,
  sessionUserId,
} from "./composio-sessions.ts";
import { toolAllowedForApps } from "./composio-filter.ts";
import { bootHarness, type BootedHarness } from "./testing/harness.ts";

const API_KEY = ["ak", "test", "sessions", Date.now().toString(36)].join("_");

function startFakeV31(): Promise<{
  server: Server;
  port: number;
  created: Array<{ user_id: string; toolkits: { enable: string[] }; manage_connections: { enable: boolean } }>;
  deleted: string[];
}> {
  const created: Array<{ user_id: string; toolkits: { enable: string[] }; manage_connections: { enable: boolean } }> = [];
  const deleted: string[] = [];
  const sessions = new Map<string, { user_id: string; mcp: { url: string; headers: Record<string, string> } }>();
  let seq = 0;
  const server = createServer((req, res) => {
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.headers["x-api-key"] !== API_KEY) return json(401, { error: "unauthorized" });
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let body: any = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      } catch {
        /* empty */
      }
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/tool_router/session" && req.method === "POST") {
        const id = `sess-${++seq}`;
        created.push({
          user_id: String(body.user_id ?? ""),
          toolkits: body.toolkits ?? { enable: [] },
          manage_connections: body.manage_connections ?? { enable: true },
        });
        const mcp = {
          url: `http://127.0.0.1/mcp/${id}`,
          headers: { "x-session": id },
        };
        sessions.set(id, { user_id: String(body.user_id ?? ""), mcp });
        return json(200, { session_id: id, mcp });
      }
      const m = url.pathname.match(/^\/tool_router\/session\/([\w-]+)$/);
      if (m && req.method === "GET") {
        const live = sessions.get(m[1]);
        if (!live) return json(404, { error: "gone" });
        return json(200, { session_id: m[1], mcp: live.mcp });
      }
      if (m && req.method === "DELETE") {
        deleted.push(m[1]);
        sessions.delete(m[1]);
        return json(200, { ok: true });
      }
      json(404, { error: "nope" });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, port, created, deleted });
    });
  });
}

describe("turn mount is Session-per-bot, not workspace ck_", () => {
  it("turns.ts mounts via ensureBotSession + sessionProxyEnv and never OMB_COMPOSIO_KEY", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "services", "turns.ts"), "utf8");
    expect(src).toContain("ensureBotSession");
    expect(src).toContain("sessionProxyEnv");
    expect(src).toContain("composioSessionKey");
    expect(src).toMatch(/enabledApps\?\.length && composioSessionKey/);
    expect(src).not.toMatch(/OMB_COMPOSIO_KEY:\s*cfg\.composio/);
  });
});

describe("session identity + mount env (no live Composio)", () => {
  it("user_id is velarix_<botId> and empty enable is none", () => {
    expect(sessionUserId("bot-a")).toBe("velarix_bot-a");
    expect(() => sessionUserId("")).toThrow(/bot id/);
  });

  it("sessionProxyEnv puts MCP URL/headers in env, never OMB_COMPOSIO_KEY", () => {
    const env = sessionProxyEnv(
      {
        sessionId: "sess-1",
        userId: "velarix_bot-a",
        botId: "bot-a",
        url: "http://127.0.0.1/mcp/sess-1",
        headers: { "x-session": "sess-1" },
      },
      ["gmail"],
    );
    expect(env.OMB_COMPOSIO_URL).toBe("http://127.0.0.1/mcp/sess-1");
    expect(JSON.parse(env.OMB_COMPOSIO_MCP_HEADERS)).toEqual({ "x-session": "sess-1" });
    expect(env.OMB_ALLOWED_TOOLKITS).toBe("gmail");
    expect(env.OMB_COMPOSIO_KEY).toBeUndefined();
    expect(JSON.stringify(env)).not.toMatch(/ak_|ck_/);
  });

  it("COMPOSIO_MANAGE_* stays blocked even when an app is enabled", () => {
    expect(toolAllowedForApps("COMPOSIO_MANAGE_CONNECTIONS", ["gmail"])).toBe(false);
    expect(toolAllowedForApps("COMPOSIO_MANAGE_TOOLS", ["gmail"])).toBe(false);
  });

  it("configured is apiKey or Connect key; Sessions path is apiKey only", () => {
    expect(composioSessionKey({})).toBeUndefined();
    expect(composioConfigured({})).toBe(false);
    expect(composioSessionKey({ composio: { key: "ck_only" } })).toBeUndefined();
    expect(composioConfigured({ composio: { key: "ck_only" } })).toBe(true);
    expect(composioSessionKey({ composio: { apiKey: API_KEY } })).toBe(API_KEY);
    expect(composioConfigured({ composio: { apiKey: API_KEY } })).toBe(true);
  });
});

describe("sessions HTTP (fake v3.1, no Connect key)", () => {
  let stub: Awaited<ReturnType<typeof startFakeV31>>;
  let h: BootedHarness;

  beforeAll(async () => {
    stub = await startFakeV31();
    h = await bootHarness({
      instances: { ghost: { driver: "not-a-real-driver", displayName: "Ghost" } },
    });
  }, 30_000);

  afterAll(async () => {
    await h?.stop();
    await new Promise<void>((r) => stub.server.close(() => r()));
  });

  it("no key/session is honest empty — Connect ck_ is not required", async () => {
    const list = await h.api("GET", "/api/connectors/sessions");
    expect(list.status).toBe(200);
    expect(list.body).toEqual({ configured: false, sessions: [] });
    expect(JSON.stringify(list.body)).not.toMatch(/ak_|ck_|secret:\/\//);

    const cfg = await h.api("GET", "/api/config");
    expect(cfg.body.composio).toEqual({
      configured: false,
      apiKeyConfigured: false,
      connectKeyConfigured: false,
    });
    expect(JSON.stringify(cfg.body)).not.toMatch(/ak_|ck_|secret:\/\//);

    const create = await h.api("POST", "/api/connectors/sessions", { botId: "missing" });
    expect(create.status).toBe(200);
    expect(create.body.configured).toBe(false);
    expect(create.body.error).toMatch(/ak_|API key/i);
  });

  it("create/list/revoke uses user_id=velarix_<botId> and never echoes the key", async () => {
    const saved = await h.api("PUT", "/api/config", {
      composio: { apiKey: API_KEY, backendUrl: `http://127.0.0.1:${stub.port}` },
    });
    expect(saved.status).toBe(200);
    expect(saved.body.composio).toEqual({
      configured: true,
      apiKeyConfigured: true,
      connectKeyConfigured: false,
    });
    expect(JSON.stringify(saved.body)).not.toContain(API_KEY);

    const bot = (await h.api("POST", "/api/bots")).body.bot;
    const created = await h.api("POST", "/api/connectors/sessions", { botId: bot.id });
    expect(created.status).toBe(200);
    expect(created.body.session.userId).toBe(`velarix_${bot.id}`);
    expect(created.body.session.botId).toBe(bot.id);
    expect(created.body.session.sessionId).toMatch(/^sess-/);
    expect(JSON.stringify(created.body)).not.toContain(API_KEY);
    expect(JSON.stringify(created.body)).not.toMatch(/mcp|x-session/);
    expect(stub.created[0]?.user_id).toBe(`velarix_${bot.id}`);
    expect(stub.created[0]?.manage_connections.enable).toBe(false);
    expect(stub.created[0]?.toolkits.enable).toEqual([]);

    const listed = await h.api("GET", "/api/connectors/sessions");
    expect(listed.body.configured).toBe(true);
    expect(listed.body.sessions).toEqual([
      { botId: bot.id, userId: `velarix_${bot.id}`, sessionId: created.body.session.sessionId },
    ]);
    expect(JSON.stringify(listed.body)).not.toContain(API_KEY);

    const revoked = await h.api("DELETE", `/api/connectors/sessions/${created.body.session.sessionId}`);
    expect(revoked.status).toBe(200);
    expect(revoked.body.revoked).toBe(true);
    expect(stub.deleted).toContain(created.body.session.sessionId);
    const empty = await h.api("GET", "/api/connectors/sessions");
    expect(empty.body.sessions).toEqual([]);
  });

  it("empty enabledApps still creates a session but the harness will not mount it", async () => {
    const bot = (await h.api("POST", "/api/bots")).body.bot;
    expect(bot.enabledApps ?? []).toEqual([]);
    const created = await h.api("POST", "/api/connectors/sessions", { botId: bot.id });
    expect(created.status).toBe(200);
    expect(stub.created.at(-1)?.toolkits.enable).toEqual([]);
    const listed = await h.api("GET", "/api/connectors/sessions");
    expect(listed.body.sessions.some((s: { botId: string }) => s.botId === bot.id)).toBe(true);
  });
});

describe("session client against the fake (isolated HOME)", () => {
  let stub: Awaited<ReturnType<typeof startFakeV31>>;

  beforeAll(async () => {
    stub = await startFakeV31();
  });

  afterAll(async () => {
    await new Promise<void>((r) => stub.server.close(() => r()));
  });

  it("create then revoke; empty enable list is none", async () => {
    const cfg = { composio: { apiKey: API_KEY, backendUrl: `http://127.0.0.1:${stub.port}` } };
    const mcp = await createSession(cfg, "bot-z", []);
    expect(mcp.userId).toBe("velarix_bot-z");
    expect(mcp.url).toContain("/mcp/");
    expect(stub.created.at(-1)?.toolkits.enable).toEqual([]);
    expect(stub.created.at(-1)?.manage_connections.enable).toBe(false);
    await revokeSession(cfg, mcp.sessionId);
    expect(stub.deleted).toContain(mcp.sessionId);
  });
});
