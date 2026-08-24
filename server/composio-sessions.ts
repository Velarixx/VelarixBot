// Composio v3.1 Sessions (tool_router). [VERIFY] 2026-08-17 against HEAD
// 7ec949a: Apps hub was Connect/ck_ only; mount was one workspace
// OMB_COMPOSIO_KEY + enabledApps[]; no Session create/list/revoke.
//
// Sessions are the mount path. Identity is user_id=velarix_<botId>.
// The project API key (ak_) is what Sessions need — Connect ck_ is
// optional and must not be required. No key/session = honest empty.
// Session ids live in a local JSON file (not Postgres / accounts /
// Docker / Cursor identity). MCP URL + headers stay in env, never argv,
// and never come back from GET /api/config.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { atomicWriteFileSync, ensurePrivateDir } from "./atomic.ts";
import type { AppConfig } from "./config.ts";
import { DATA_DIR } from "./config.ts";
import { parseAllowedToolkits } from "./composio-filter.ts";
import { currentToolListGeneration, invalidateToolLists } from "./connector-lifecycle.ts";

export const COMPOSIO_V31 = "https://backend.composio.dev/api/v3.1";
export const SESSION_USER_PREFIX = "velarix_";

export function sessionUserId(botId: string): string {
  const id = String(botId ?? "").trim();
  if (!id) throw new Error("session user_id needs a bot id");
  return `${SESSION_USER_PREFIX}${id}`;
}

export function composioBackendUrl(cfg: AppConfig): string {
  const url = cfg.composio?.backendUrl?.trim();
  return (url || COMPOSIO_V31).replace(/\/$/, "");
}

/** Sessions path = project API key. Connect ck_ is not required. */
export function composioSessionKey(cfg: AppConfig): string | undefined {
  const key = cfg.composio?.apiKey?.trim();
  return key || undefined;
}

export function composioConfigured(cfg: AppConfig): boolean {
  return Boolean(composioSessionKey(cfg) || cfg.composio?.key);
}

export interface StoredSession {
  botId: string;
  userId: string;
  sessionId: string;
}

export interface SessionMcp {
  sessionId: string;
  userId: string;
  botId: string;
  url: string;
  headers: Record<string, string>;
}

interface SessionFile {
  sessions: StoredSession[];
}

function storePath(): string {
  return join(DATA_DIR, "composio-sessions.json");
}

function readStore(): SessionFile {
  try {
    const raw = JSON.parse(readFileSync(storePath(), "utf8")) as SessionFile;
    const sessions = Array.isArray(raw.sessions) ? raw.sessions : [];
    return {
      sessions: sessions.filter(
        (s): s is StoredSession =>
          !!s &&
          typeof s.botId === "string" &&
          typeof s.userId === "string" &&
          typeof s.sessionId === "string" &&
          s.userId === sessionUserId(s.botId),
      ),
    };
  } catch {
    return { sessions: [] };
  }
}

function writeStore(file: SessionFile): void {
  ensurePrivateDir(DATA_DIR);
  atomicWriteFileSync(storePath(), JSON.stringify(file, null, 2));
}

export function listStoredSessions(): StoredSession[] {
  return readStore().sessions;
}

export function storedSessionForBot(botId: string): StoredSession | null {
  return readStore().sessions.find((s) => s.botId === botId) ?? null;
}

function upsertStored(session: StoredSession): void {
  const file = readStore();
  file.sessions = file.sessions.filter((s) => s.botId !== session.botId && s.sessionId !== session.sessionId);
  file.sessions.push(session);
  writeStore(file);
}

function dropStored(sessionId: string): void {
  const file = readStore();
  file.sessions = file.sessions.filter((s) => s.sessionId !== sessionId);
  writeStore(file);
}

async function sessionFetch(cfg: AppConfig, path: string, opts: RequestInit = {}): Promise<{ ok: boolean; status: number; body: any }> {
  const key = composioSessionKey(cfg);
  if (!key) throw new Error("no Composio API key — add one in App Settings to use Sessions");
  const res = await fetch(`${composioBackendUrl(cfg)}${path}`, {
    ...opts,
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      ...(opts.headers ?? {}),
    },
    signal: opts.signal ?? AbortSignal.timeout(20_000),
  });
  const body = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, body };
}

function mcpFromBody(body: any, botId: string, userId: string): SessionMcp | null {
  const sessionId = String(body?.session_id ?? body?.id ?? "").trim();
  const mcp = body?.mcp && typeof body.mcp === "object" ? body.mcp : {};
  const url = typeof mcp.url === "string" ? mcp.url.trim() : "";
  if (!sessionId || !url) return null;
  const headers: Record<string, string> = {};
  if (mcp.headers && typeof mcp.headers === "object" && !Array.isArray(mcp.headers)) {
    for (const [k, v] of Object.entries(mcp.headers as Record<string, unknown>)) {
      if (typeof v === "string" && v) headers[k] = v;
    }
  }
  return { sessionId, userId, botId, url, headers };
}

function createBody(botId: string, enabledApps: string[]) {
  const slugs = parseAllowedToolkits(enabledApps);
  return {
    user_id: sessionUserId(botId),
    // empty enable list = none (never "all apps")
    toolkits: { enable: slugs },
    // connection management stays on the workspace UI — never on the bot
    manage_connections: { enable: false, enable_connection_removal: false },
    workbench: { enable: false },
  };
}

export async function createSession(cfg: AppConfig, botId: string, enabledApps: string[] = []): Promise<SessionMcp> {
  const userId = sessionUserId(botId);
  const { ok, status, body } = await sessionFetch(cfg, "/tool_router/session", {
    method: "POST",
    body: JSON.stringify(createBody(botId, enabledApps)),
  });
  if (!ok) throw new Error(`Composio session create failed (${status})`);
  const mcp = mcpFromBody(body, botId, userId);
  if (!mcp) throw new Error("Composio session create returned no session_id/mcp.url");
  upsertStored({ botId, userId, sessionId: mcp.sessionId });
  invalidateToolLists("reconnect");
  return mcp;
}

export async function getSession(cfg: AppConfig, sessionId: string, botId: string): Promise<SessionMcp | null> {
  const { ok, body } = await sessionFetch(cfg, `/tool_router/session/${encodeURIComponent(sessionId)}`);
  if (!ok) return null;
  return mcpFromBody(body, botId, sessionUserId(botId));
}

export async function revokeSession(cfg: AppConfig, sessionId: string): Promise<{ revoked: boolean }> {
  const { ok, status } = await sessionFetch(cfg, `/tool_router/session/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
  });
  dropStored(sessionId);
  invalidateToolLists("disconnect");
  if (!ok && status !== 404) throw new Error(`Composio session revoke failed (${status})`);
  return { revoked: true };
}

/** Public list: ids + user_id only — never MCP URLs or headers. */
export function publicSessions(): Array<{ botId: string; userId: string; sessionId: string }> {
  return listStoredSessions().map((s) => ({ botId: s.botId, userId: s.userId, sessionId: s.sessionId }));
}

/**
 * Ensure a Session for this bot and return the MCP spawn facts.
 * Reuses the stored id when GET still works; otherwise creates.
 * No API key → null (honest empty). Empty enabledApps still creates a
 * session (hub create/list/revoke) but the harness will not mount it.
 */
export async function ensureBotSession(cfg: AppConfig, botId: string, enabledApps: string[] = []): Promise<SessionMcp | null> {
  if (!composioSessionKey(cfg)) return null;
  const stored = storedSessionForBot(botId);
  if (stored) {
    const live = await getSession(cfg, stored.sessionId, botId).catch(() => null);
    if (live) return live;
    dropStored(stored.sessionId);
    invalidateToolLists("reconnect");
  }
  return createSession(cfg, botId, enabledApps);
}

/** Env for the composio-proxy — secrets in env, never argv. */
export function sessionProxyEnv(mcp: SessionMcp, allowedApps: string[]): Record<string, string> {
  const headers = { ...mcp.headers };
  return {
    OMB_COMPOSIO_URL: mcp.url,
    OMB_COMPOSIO_MCP_HEADERS: JSON.stringify(headers),
    OMB_ALLOWED_TOOLKITS: parseAllowedToolkits(allowedApps).join(","),
    OMB_COMPOSIO_TOOL_GEN: String(currentToolListGeneration()),
  };
}

export function sessionsStoreExists(): boolean {
  return existsSync(storePath());
}
