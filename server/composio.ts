// Composio — two clients in one file:
//  1) the Connect meta-MCP (connect.composio.dev) for connection state +
//     auth links, ported from agentcal src/composio.js
//  2) the v3 toolkits catalog (backend.composio.dev) for the plugin
//     marketplace — names, descriptions, logos. Works when the key is a
//     project API key; when it isn't, the caller falls back to the curated
//     catalog below (logos then resolve via favicon fallback client-side).
import type { AppConfig } from "./config.ts";
import { composioBackendUrl, composioSessionKey, sessionUserId } from "./composio-sessions.ts";
import {
  allocateConnectorIdentity,
  claimConnectorIdentity,
  clearOAuth,
  detectStaleAuth,
  invalidateToolLists,
  markOAuth,
  oauthRecord,
  redactConnectorDiagnostics,
  snapshotForConnector,
  writeIdentityMap,
  ConnectorError,
  type ClaimedConnectorIdentity,
  type ConnectorHealthSnapshot,
} from "./connector-lifecycle.ts";

const CONNECT_URL = "https://connect.composio.dev/mcp";
const BACKEND_URL = "https://backend.composio.dev/api/v3";

function parseMcpResponse(text: string) {
  // Streamable-HTTP servers answer JSON or SSE (`data: {...}` lines).
  const line = text.startsWith("{")
    ? text
    : text.split("\n").find((l) => l.startsWith("data: "))?.slice(6);
  if (!line) throw new Error("empty MCP response");
  const msg = JSON.parse(line);
  if (msg.error) throw new Error(msg.error.message || "MCP error");
  const content = msg.result?.content?.find((c: any) => c.type === "text")?.text;
  if (!content) return msg.result ?? null;
  try {
    return JSON.parse(content);
  } catch {
    return { text: content };
  }
}

export async function composioTool(cfg: AppConfig, name: string, args: unknown) {
  if (!cfg.composio?.key) {
    throw new Error('no Composio key configured — add {"composio":{"key":"ck_…"}} to ~/.velarixbot/config.json');
  }
  const res = await fetch(cfg.composio.url || CONNECT_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "x-consumer-api-key": cfg.composio.key,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Composio MCP: HTTP ${res.status}`);
  return parseMcpResponse(await res.text());
}

export type ConnectorServiceStatus = ConnectorHealthSnapshot & {
  accounts?: ConnectorHealthSnapshot[];
};

function accountKeyOf(account: any): string {
  return String(account?.id ?? account?.account_id ?? account?.nanoid ?? "").trim();
}

function accountRemoteStatus(account: any, fallback = "unknown"): string {
  return String(account?.status ?? account?.connection_status ?? fallback);
}

function snapshotsForAccounts(
  slug: string,
  accounts: any[],
  botId: string | undefined,
  fallbackStatus: string,
): ConnectorHealthSnapshot[] {
  const claimed: ClaimedConnectorIdentity[] = [];
  const out: ConnectorHealthSnapshot[] = [];
  const prev = oauthRecord(botId, slug);
  const list = accounts.length ? accounts : [null];
  for (const account of list) {
    const key = account ? accountKeyOf(account) : undefined;
    const allocated = allocateConnectorIdentity(claimed, slug, key || undefined);
    claimed.push({ identity: allocated.identity, ...(key ? { accountKey: key } : {}) });
    const remote = account ? accountRemoteStatus(account, fallbackStatus) : fallbackStatus;
    const snap = snapshotForConnector({
      slug,
      identity: allocated.identity,
      remoteStatus: remote,
      previousHealth: prev?.health,
      previousOauth: prev?.phase,
    });
    if (snap.health === "stale" || detectStaleAuth({ remoteStatus: remote, previousHealth: prev?.health, previousOauth: prev?.phase })) {
      invalidateToolLists("stale");
    }
    if (snap.health === "connected") markOAuth({ botId, slug, identity: snap.identity }, "completed", "connected");
    out.push(snap);
  }
  return out;
}

function serviceFromSnapshots(slug: string, snapshots: ConnectorHealthSnapshot[]): ConnectorServiceStatus {
  const primary = snapshots.find((s) => s.identity === slug) ?? snapshots[0]!;
  const extras = snapshots.filter((s) => s.identity !== primary.identity);
  return {
    ...primary,
    connected: snapshots.some((s) => s.connected),
    ...(extras.length ? { accounts: snapshots } : {}),
  };
}

function emptyServices(slugs: string[], configured: boolean): Record<string, ConnectorServiceStatus> {
  const status: Record<string, ConnectorServiceStatus> = {};
  for (const slug of slugs) {
    const snap = snapshotForConnector({ slug, configured, remoteStatus: configured ? "unknown" : "not_configured" });
    status[slug] = snap;
  }
  return status;
}

/** Connection status per service slug. Sessions path (apiKey + user_id)
 * first; Connect ck_ is the fallback. Each entry is a health snapshot
 * (connected / needsAuth / error / stale) plus a next step. `connected`
 * stays for Slack listeners and older clients. */
export async function connectionStatus(cfg: AppConfig, slugs: string[], botId?: string) {
  if (composioSessionKey(cfg) && botId) {
    return connectionStatusForUser(cfg, slugs, sessionUserId(botId), botId);
  }
  if (!cfg.composio?.key) {
    return emptyServices(slugs, false);
  }
  try {
    const out = await composioTool(cfg, "COMPOSIO_MANAGE_CONNECTIONS", {
      toolkits: slugs.map((name) => ({ name, action: "list" })),
    });
    const results = out?.data?.results ?? {};
    const status: Record<string, ConnectorServiceStatus> = {};
    for (const slug of slugs) {
      const r = results[slug];
      const accounts = Array.isArray(r?.accounts) ? r.accounts : [];
      const fallback = String(r?.status ?? (accounts.length ? "unknown" : "unknown"));
      const snapshots = snapshotsForAccounts(slug, accounts, botId, fallback);
      const service = serviceFromSnapshots(slug, snapshots);
      const wrote = writeIdentityMap(status, service.identity, service);
      if (!wrote.ok) {
        const alt = allocateConnectorIdentity(
          Object.keys(status).map((identity) => ({ identity })),
          slug,
          accountKeyOf(accounts[0]),
        );
        status[alt.identity] = { ...service, identity: alt.identity };
      }
      if (service.identity !== slug && !status[slug]) status[slug] = service;
    }
    return redactConnectorDiagnostics(status) as Record<string, ConnectorServiceStatus>;
  } catch (e) {
    const status: Record<string, ConnectorServiceStatus> = {};
    for (const slug of slugs) {
      status[slug] = snapshotForConnector({ slug, error: e, previousOauth: oauthRecord(botId, slug)?.phase });
    }
    return redactConnectorDiagnostics(status) as Record<string, ConnectorServiceStatus>;
  }
}

async function backendGet(cfg: AppConfig, path: string): Promise<{ ok: boolean; status: number; body: any }> {
  const key = composioSessionKey(cfg);
  if (!key) throw new Error("no Composio API key");
  const res = await fetch(`${composioBackendUrl(cfg)}${path}`, {
    headers: { "x-api-key": key },
    signal: AbortSignal.timeout(15_000),
  });
  return { ok: res.ok, status: res.status, body: await res.json().catch(() => null) };
}

async function backendPost(cfg: AppConfig, path: string, body: unknown): Promise<{ ok: boolean; status: number; body: any }> {
  const key = composioSessionKey(cfg);
  if (!key) throw new Error("no Composio API key");
  const res = await fetch(`${composioBackendUrl(cfg)}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  return { ok: res.ok, status: res.status, body: await res.json().catch(() => null) };
}

async function backendDelete(cfg: AppConfig, path: string): Promise<{ ok: boolean; status: number; body: any }> {
  const key = composioSessionKey(cfg);
  if (!key) throw new Error("no Composio API key");
  const res = await fetch(`${composioBackendUrl(cfg)}${path}`, {
    method: "DELETE",
    headers: { "x-api-key": key },
    signal: AbortSignal.timeout(15_000),
  });
  return { ok: res.ok, status: res.status, body: await res.json().catch(() => null) };
}

function accountsOf(body: any): any[] {
  const items = body?.items ?? body?.data ?? body?.connected_accounts ?? [];
  return Array.isArray(items) ? items : [];
}

async function connectionStatusForUser(cfg: AppConfig, slugs: string[], userId: string, botId?: string) {
  try {
    const q = new URLSearchParams({ user_ids: userId });
    if (slugs.length) q.set("toolkit_slugs", slugs.join(","));
    const { body } = await backendGet(cfg, `/connected_accounts?${q}`);
    const accounts = accountsOf(body);
    const status: Record<string, ConnectorServiceStatus> = {};
    for (const slug of slugs) {
      const mine = accounts.filter(
        (a: any) => String(a.toolkit?.slug ?? a.toolkit_slug ?? a.appName ?? "").toLowerCase() === slug,
      );
      const snapshots = snapshotsForAccounts(slug, mine, botId, mine.length ? "unknown" : "unknown");
      const service = serviceFromSnapshots(slug, snapshots);
      const wrote = writeIdentityMap(status, service.identity, service);
      if (!wrote.ok) {
        const alt = allocateConnectorIdentity(
          Object.keys(status).map((identity) => ({ identity })),
          slug,
        );
        status[alt.identity] = { ...service, identity: alt.identity };
      }
      if (service.identity !== slug && !status[slug]) status[slug] = service;
    }
    return redactConnectorDiagnostics(status) as Record<string, ConnectorServiceStatus>;
  } catch (e) {
    const status: Record<string, ConnectorServiceStatus> = {};
    for (const slug of slugs) {
      status[slug] = snapshotForConnector({ slug, error: e, previousOauth: oauthRecord(botId, slug)?.phase });
    }
    return redactConnectorDiagnostics(status) as Record<string, ConnectorServiceStatus>;
  }
}

/** Disconnect a service: remove every connected account for the slug. */
export async function removeService(cfg: AppConfig, slug: string, botId?: string) {
  invalidateToolLists("disconnect");
  clearOAuth(botId, slug);
  markOAuth({ botId, slug }, "idle", "needsAuth");
  if (composioSessionKey(cfg) && botId) {
    const userId = sessionUserId(botId);
    const q = new URLSearchParams({ user_ids: userId, toolkit_slugs: slug });
    const { body } = await backendGet(cfg, `/connected_accounts?${q}`);
    const ids = accountsOf(body)
      .map((a: any) => a.id ?? a.account_id ?? a.nanoid)
      .filter(Boolean);
    for (const id of ids) {
      await backendDelete(cfg, `/connected_accounts/${encodeURIComponent(String(id))}`);
    }
    return redactConnectorDiagnostics({
      removed: ids.length,
      identity: slug,
      health: "needsAuth",
      oauth: "idle",
      nextStep: snapshotForConnector({ slug, remoteStatus: "unknown" }).nextStep,
    });
  }
  const out = await composioTool(cfg, "COMPOSIO_MANAGE_CONNECTIONS", {
    toolkits: [{ name: slug, action: "list" }],
  });
  const accounts = out?.data?.results?.[slug]?.accounts ?? [];
  const ids = accounts.map((a: any) => a.id ?? a.account_id ?? a.nanoid).filter(Boolean);
  for (const id of ids) {
    await composioTool(cfg, "COMPOSIO_MANAGE_CONNECTIONS", {
      toolkits: [{ name: slug, action: "remove", account_id: id }],
    });
  }
  return redactConnectorDiagnostics({
    removed: ids.length,
    identity: slug,
    health: "needsAuth",
    oauth: "idle",
    nextStep: snapshotForConnector({ slug, remoteStatus: "unknown" }).nextStep,
  });
}

async function existingAccountsForSlug(cfg: AppConfig, slug: string, botId?: string): Promise<any[]> {
  if (composioSessionKey(cfg) && botId) {
    const q = new URLSearchParams({ user_ids: sessionUserId(botId), toolkit_slugs: slug });
    const { body } = await backendGet(cfg, `/connected_accounts?${q}`);
    return accountsOf(body);
  }
  if (!cfg.composio?.key) return [];
  const out = await composioTool(cfg, "COMPOSIO_MANAGE_CONNECTIONS", {
    toolkits: [{ name: slug, action: "list" }],
  });
  return out?.data?.results?.[slug]?.accounts ?? [];
}

function claimAuthorizeIdentity(slug: string, accounts: any[]): string {
  const claimed: ClaimedConnectorIdentity[] = [];
  for (const account of accounts) {
    const key = accountKeyOf(account);
    const allocated = allocateConnectorIdentity(claimed, slug, key || undefined);
    claimed.push({ identity: allocated.identity, ...(key ? { accountKey: key } : {}) });
  }
  const active = accounts.find((a) => /active/i.test(accountRemoteStatus(a)));
  if (active) return allocateConnectorIdentity(claimed, slug, accountKeyOf(active) || undefined).identity;
  if (claimed.length) return claimed[0]!.identity;
  const claim = claimConnectorIdentity(claimed, slug);
  if ("collision" in claim) {
    throw new ConnectorError("identity_collision", claim.reason);
  }
  return claim.identity;
}

/** Mint a browser auth link for one service. Tracks OAuth lifecycle,
 * rejects identity collisions, and invalidates cached tool lists. */
export async function authorizeService(cfg: AppConfig, slug: string, botId?: string) {
  if (!composioSessionKey(cfg) && !cfg.composio?.key) {
    throw new ConnectorError("not_configured", "no Composio key configured");
  }
  const existing = await existingAccountsForSlug(cfg, slug, botId).catch(() => []);
  const identity = claimAuthorizeIdentity(slug, existing);
  markOAuth({ botId, slug, identity }, "initiated", "needsAuth");
  invalidateToolLists("auth_change");

  try {
    if (composioSessionKey(cfg) && botId) {
      const { ok, status, body } = await backendPost(cfg, "/connected_accounts", {
        user_id: sessionUserId(botId),
        toolkit: slug,
      });
      if (!ok) throw new ConnectorError("auth_failed", `Composio authorize failed (${status})`);
      const raw = JSON.stringify(body);
      const urls = raw.match(/https:\/\/[^"\\\s]+/g) ?? [];
      const url = urls.find((u) => /composio|connect|auth/i.test(u)) ?? urls[0];
      if (!url) throw new ConnectorError("upstream", `Composio returned no auth link for ${slug}`);
      markOAuth({ botId, slug, identity }, "pending", "needsAuth");
      return redactConnectorDiagnostics({
        url,
        identity,
        health: "needsAuth",
        oauth: "pending",
        nextStep: snapshotForConnector({ slug, identity, remoteStatus: "INITIATED", previousOauth: "pending" }).nextStep,
      });
    }
    const out = await composioTool(cfg, "COMPOSIO_MANAGE_CONNECTIONS", {
      toolkits: [{ name: slug, action: "add" }],
    });
    const raw = JSON.stringify(out);
    const urls = raw.match(/https:\/\/[^"\\\s]+/g) ?? [];
    const url = urls.find((u) => /composio|connect|auth/i.test(u)) ?? urls[0];
    if (!url) throw new ConnectorError("upstream", `Composio returned no auth link for ${slug}`);
    markOAuth({ botId, slug, identity }, "pending", "needsAuth");
    return redactConnectorDiagnostics({
      url,
      identity,
      health: "needsAuth",
      oauth: "pending",
      nextStep: snapshotForConnector({ slug, identity, remoteStatus: "INITIATED", previousOauth: "pending" }).nextStep,
    });
  } catch (e) {
    if (e instanceof ConnectorError && e.code === "identity_collision") throw e;
    const failed = e instanceof ConnectorError ? e : e;
    markOAuth({ botId, slug, identity }, "failed", "error");
    throw failed;
  }
}

// ── marketplace catalog ────────────────────────────────────────────────
export interface ToolkitCard {
  slug: string;
  label: string;
  blurb: string;
  logo: string | null;
  /** used for the client-side favicon fallback when logo is null/broken */
  domain: string | null;
}

// Curated fallback — the services agentcal's connectors page ships plus the
// long marketplace tail. Logos resolve client-side:
// logo → favicon(domain) → monogram.
const CURATED: ToolkitCard[] = [
  { slug: "slack", label: "Slack", blurb: "Post updates and read channels", domain: "slack.com", logo: null },
  { slug: "github", label: "GitHub", blurb: "Issues, pull requests, and code", domain: "github.com", logo: null },
  { slug: "gmail", label: "Gmail", blurb: "Read and send email", domain: "gmail.com", logo: null },
  { slug: "googlecalendar", label: "Google Calendar", blurb: "Read and create events", domain: "calendar.google.com", logo: null },
  { slug: "googlesheets", label: "Google Sheets", blurb: "Read and update spreadsheets", domain: "sheets.google.com", logo: null },
  { slug: "googledocs", label: "Google Docs", blurb: "Read and write documents", domain: "docs.google.com", logo: null },
  { slug: "googledrive", label: "Google Drive", blurb: "Browse and manage files", domain: "drive.google.com", logo: null },
  { slug: "notion", label: "Notion", blurb: "Pages and databases", domain: "notion.so", logo: null },
  { slug: "linear", label: "Linear", blurb: "Issues and project tracking", domain: "linear.app", logo: null },
  { slug: "sentry", label: "Sentry", blurb: "Errors and alerts", domain: "sentry.io", logo: null },
  { slug: "posthog", label: "PostHog", blurb: "Analytics, feature flags, experiments", domain: "posthog.com", logo: null },
  { slug: "discord", label: "Discord", blurb: "Messages and channels", domain: "discord.com", logo: null },
  { slug: "x", label: "X (Twitter)", blurb: "Post and read on X", domain: "x.com", logo: null },
  { slug: "reddit", label: "Reddit", blurb: "Browse and post", domain: "reddit.com", logo: null },
  { slug: "zapier", label: "Zapier", blurb: "Connect 9,000+ apps", domain: "zapier.com", logo: null },
  { slug: "hubspot", label: "HubSpot", blurb: "CRM search & updates", domain: "hubspot.com", logo: null },
  { slug: "salesforce", label: "Salesforce", blurb: "CRM records and reports", domain: "salesforce.com", logo: null },
  { slug: "jira", label: "Jira", blurb: "Issues and sprints", domain: "atlassian.com", logo: null },
  { slug: "asana", label: "Asana", blurb: "Tasks and projects", domain: "asana.com", logo: null },
  { slug: "trello", label: "Trello", blurb: "Boards and cards", domain: "trello.com", logo: null },
  { slug: "dropbox", label: "Dropbox", blurb: "Files and folders", domain: "dropbox.com", logo: null },
  { slug: "airtable", label: "Airtable", blurb: "Bases and records", domain: "airtable.com", logo: null },
  { slug: "figma", label: "Figma", blurb: "Files and comments", domain: "figma.com", logo: null },
  { slug: "stripe", label: "Stripe", blurb: "Payments and customers", domain: "stripe.com", logo: null },
];

let toolkitCache: { at: number; cards: ToolkitCard[] } | null = null;

/**
 * Marketplace catalog. Tries the v3 toolkits API (official names,
 * descriptions, logos — cached 10 min); falls back to the curated list.
 */
export async function listToolkits(cfg: AppConfig): Promise<{ cards: ToolkitCard[]; source: "api" | "curated" }> {
  if (toolkitCache && Date.now() - toolkitCache.at < 10 * 60_000) {
    return { cards: toolkitCache.cards, source: "api" };
  }
  const backendKey = cfg.composio?.apiKey ?? cfg.composio?.key;
  if (backendKey) {
    try {
      const base = cfg.composio?.backendUrl?.trim() ? composioBackendUrl(cfg) : BACKEND_URL;
      const res = await fetch(`${base}/toolkits?limit=500&sort_by=usage`, {
        headers: { "x-api-key": backendKey },
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) {
        const json: any = await res.json();
        const items = json.items ?? json.data ?? [];
        if (Array.isArray(items) && items.length) {
          const cards: ToolkitCard[] = items.map((t: any) => ({
            slug: (t.slug ?? t.key ?? t.name ?? "").toLowerCase(),
            label: t.name ?? t.slug ?? "",
            blurb: (t.meta?.description ?? t.description ?? "").slice(0, 90),
            logo: t.meta?.logo ?? t.logo ?? null,
            domain: null,
          }));
          toolkitCache = { at: Date.now(), cards };
          return { cards, source: "api" };
        }
      }
    } catch {
      /* fall through to curated */
    }
  }
  return { cards: CURATED, source: "curated" };
}

export const CURATED_SLUGS = CURATED.map((c) => c.slug);
