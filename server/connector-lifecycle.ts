// MCP connector lifecycle + diagnostics (Priority 5).
//
// Extends the existing Apps hub / Composio session path — this is the
// algebra, not a second connector runtime. Health, OAuth phase, stale-auth,
// tool-list cache, normalized failures, redacted diagnostics, and identity
// collisions live here so the hub can stay the one stack.
//
// Secrets never belong in logs, events, diagnostics, or argv.

import { redactSecrets } from "./redact.ts";

export const CONNECTOR_HEALTHS = ["connected", "needsAuth", "error", "stale"] as const;
export type ConnectorHealth = (typeof CONNECTOR_HEALTHS)[number];

export const CONNECTOR_OAUTH_PHASES = ["idle", "initiated", "pending", "completed", "failed"] as const;
export type ConnectorOAuthPhase = (typeof CONNECTOR_OAUTH_PHASES)[number];

export const CONNECTOR_ERROR_CODES = [
  "not_configured",
  "auth_required",
  "auth_stale",
  "auth_failed",
  "identity_collision",
  "upstream",
  "timeout",
] as const;
export type ConnectorErrorCode = (typeof CONNECTOR_ERROR_CODES)[number];

export const TOOL_LIST_INVALIDATE_REASONS = ["reconnect", "auth_change", "disconnect", "stale"] as const;
export type ToolListInvalidateReason = (typeof TOOL_LIST_INVALIDATE_REASONS)[number];

export interface ConnectorHealthSnapshot {
  identity: string;
  slug: string;
  health: ConnectorHealth;
  nextStep: string;
  oauth: ConnectorOAuthPhase;
  connected: boolean;
  status: string;
  errorCode?: ConnectorErrorCode;
}

export interface ConnectorOAuthRecord {
  botId: string;
  slug: string;
  identity: string;
  phase: ConnectorOAuthPhase;
  health?: ConnectorHealth;
}

export class ConnectorError extends Error {
  readonly code: ConnectorErrorCode;
  readonly status: number;
  constructor(code: ConnectorErrorCode, message: string, status?: number) {
    super(message);
    this.name = "ConnectorError";
    this.code = code;
    this.status = status ?? httpStatusForConnectorCode(code);
  }
}

export function httpStatusForConnectorCode(code: ConnectorErrorCode): number {
  if (code === "identity_collision") return 409;
  if (code === "not_configured") return 400;
  if (code === "timeout" || code === "upstream") return 502;
  return 400;
}

export function normalizeSlug(slug: string): string {
  return String(slug ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "");
}

export function identitySlug(identity: string): string {
  const raw = String(identity ?? "").trim().toLowerCase();
  return raw.split(":")[0] ?? raw;
}

export function oauthStorageKey(botId: string | undefined, slug: string): string {
  return `${String(botId ?? "_").trim() || "_"}:${normalizeSlug(slug)}`;
}

export const CONNECTOR_NEXT_STEP: Record<ConnectorHealth, string> = {
  connected: "App is connected. Enable it for this bot to mount its tools.",
  needsAuth: "Connect this app, then finish sign-in in the browser.",
  stale: "Sign-in expired. Connect again to refresh access.",
  error: "Connection failed. Check the app, then try Connect again.",
};

export function nextStepFor(health: ConnectorHealth, errorCode?: ConnectorErrorCode): string {
  if (errorCode === "not_configured") return "Add a Composio API key in App Settings.";
  if (errorCode === "identity_collision") {
    return "This account is already connected. Disconnect it first, or use a different account.";
  }
  if (errorCode === "timeout") return "The apps service timed out. Refresh status, then try again.";
  if (errorCode === "upstream") return "The apps service is unreachable. Refresh status, then try again.";
  if (errorCode === "auth_required") return CONNECTOR_NEXT_STEP.needsAuth;
  if (errorCode === "auth_stale") return CONNECTOR_NEXT_STEP.stale;
  if (errorCode === "auth_failed") return CONNECTOR_NEXT_STEP.error;
  return CONNECTOR_NEXT_STEP[health];
}

export function healthForErrorCode(code: ConnectorErrorCode): ConnectorHealth {
  if (code === "auth_stale") return "stale";
  if (code === "auth_required" || code === "not_configured") return "needsAuth";
  return "error";
}

function oauthForHealth(health: ConnectorHealth, previous?: ConnectorOAuthPhase): ConnectorOAuthPhase {
  if (health === "connected") return "completed";
  if (health === "stale") return previous === "completed" || previous === "pending" ? previous : "completed";
  if (health === "error") return previous === "initiated" || previous === "pending" ? "failed" : (previous ?? "failed");
  if (previous === "initiated" || previous === "pending") return previous;
  return previous ?? "idle";
}

export interface ClaimedConnectorIdentity {
  identity: string;
  accountKey?: string;
}

/** Always succeeds. First account on a slug keeps `slug`; later distinct
 * accounts get `slug:<accountKey>` (or `slug:2`) so a status map cannot
 * silently overwrite one account with another. */
export function allocateConnectorIdentity(
  claimed: ReadonlyArray<ClaimedConnectorIdentity>,
  slug: string,
  accountKey?: string,
): { identity: string; suffixed: boolean } {
  const normalized = normalizeSlug(slug);
  if (!normalized) throw new ConnectorError("upstream", "connector identity needs a slug");
  const key = accountKey?.trim() || undefined;
  if (key) {
    const same = claimed.find((c) => c.accountKey === key && identitySlug(c.identity) === normalized);
    if (same) return { identity: same.identity, suffixed: same.identity !== normalized };
  }
  const slugTaken = claimed.some((c) => c.identity === normalized);
  if (!slugTaken) return { identity: normalized, suffixed: false };
  const used = new Set(claimed.map((c) => c.identity));
  const base = key && /^[a-z0-9_-]+$/i.test(key) ? `${normalized}:${key}` : `${normalized}:2`;
  let identity = base;
  let n = 2;
  while (used.has(identity)) identity = `${normalized}:${n++}`;
  return { identity, suffixed: true };
}

/** Authorize-time claim. Reclaiming the same account is fine. Claiming the
 * bare slug when a different account already holds it is a collision —
 * reject so two accounts on one server do not silently overwrite. Distinct
 * account keys are suffixed. */
export function claimConnectorIdentity(
  claimed: ReadonlyArray<ClaimedConnectorIdentity>,
  slug: string,
  accountKey?: string,
): { identity: string } | { collision: true; identity: string; reason: string } {
  const normalized = normalizeSlug(slug);
  const key = accountKey?.trim() || undefined;
  const holder = claimed.find((c) => c.identity === normalized);
  if (holder && key && holder.accountKey && holder.accountKey !== key) {
    return {
      collision: true,
      identity: normalized,
      reason: "connector identity already claimed by another account",
    };
  }
  if (holder && !key && holder.accountKey) {
    return {
      collision: true,
      identity: normalized,
      reason: "connector identity already claimed by another account",
    };
  }
  const allocated = allocateConnectorIdentity(claimed, slug, key);
  return { identity: allocated.identity };
}

/** Refuse to overwrite an existing identity in a map. Caller must suffix. */
export function writeIdentityMap<T>(
  map: Record<string, T>,
  identity: string,
  value: T,
): { ok: true } | { ok: false; code: "identity_collision"; identity: string } {
  const id = String(identity ?? "").trim();
  if (!id) return { ok: false, code: "identity_collision", identity: id };
  if (Object.prototype.hasOwnProperty.call(map, id)) {
    return { ok: false, code: "identity_collision", identity: id };
  }
  map[id] = value;
  return { ok: true };
}

const STALE_REMOTE = /expired|revoked|invalid_grant|token_expired|needs?_?reauth|unauthorized|stale/i;

export function detectStaleAuth(input: {
  remoteStatus?: string;
  httpStatus?: number;
  previousHealth?: ConnectorHealth;
  previousOauth?: ConnectorOAuthPhase;
  errorMessage?: string;
}): boolean {
  const remote = String(input.remoteStatus ?? "");
  if (STALE_REMOTE.test(remote)) return true;
  const wasGranted = input.previousHealth === "connected" || input.previousOauth === "completed";
  if (input.httpStatus === 401 || input.httpStatus === 403) {
    return wasGranted || STALE_REMOTE.test(String(input.errorMessage ?? ""));
  }
  if (wasGranted && /initiated/i.test(remote)) return true;
  const err = String(input.errorMessage ?? "");
  if (wasGranted && STALE_REMOTE.test(err)) return true;
  return false;
}

function remoteLooksConnected(status: string): boolean {
  return /^active$/i.test(status) || /connected/i.test(status);
}

function remoteLooksPending(status: string): boolean {
  return /initiated|pending|in_progress/i.test(status);
}

export function healthFromRemote(input: {
  remoteStatus?: string;
  httpStatus?: number;
  configured?: boolean;
  previousHealth?: ConnectorHealth;
  previousOauth?: ConnectorOAuthPhase;
  error?: unknown;
}): Pick<ConnectorHealthSnapshot, "health" | "oauth" | "status" | "connected" | "errorCode"> {
  if (input.configured === false) {
    return {
      health: "needsAuth",
      oauth: "idle",
      status: "not_configured",
      connected: false,
      errorCode: "not_configured",
    };
  }
  if (input.error !== undefined) {
    const n = normalizeConnectorFailure(input.error);
    return {
      health: n.health,
      oauth: oauthForHealth(n.health, input.previousOauth),
      status: n.code,
      connected: false,
      errorCode: n.code,
    };
  }
  const remote = String(input.remoteStatus ?? "unknown");
  if (
    detectStaleAuth({
      remoteStatus: remote,
      httpStatus: input.httpStatus,
      previousHealth: input.previousHealth,
      previousOauth: input.previousOauth,
    })
  ) {
    return {
      health: "stale",
      oauth: oauthForHealth("stale", input.previousOauth),
      status: remote || "stale",
      connected: false,
      errorCode: "auth_stale",
    };
  }
  if (remoteLooksConnected(remote)) {
    return { health: "connected", oauth: "completed", status: remote, connected: true };
  }
  if (remoteLooksPending(remote) || input.previousOauth === "initiated" || input.previousOauth === "pending") {
    return {
      health: "needsAuth",
      oauth: input.previousOauth === "initiated" ? "initiated" : "pending",
      status: remote,
      connected: false,
      errorCode: "auth_required",
    };
  }
  return { health: "needsAuth", oauth: input.previousOauth ?? "idle", status: remote || "unknown", connected: false };
}

export function snapshotForConnector(input: {
  slug: string;
  identity?: string;
  remoteStatus?: string;
  httpStatus?: number;
  configured?: boolean;
  previousHealth?: ConnectorHealth;
  previousOauth?: ConnectorOAuthPhase;
  error?: unknown;
}): ConnectorHealthSnapshot {
  const slug = normalizeSlug(input.slug);
  const derived = healthFromRemote(input);
  return {
    identity: input.identity ?? slug,
    slug,
    health: derived.health,
    nextStep: nextStepFor(derived.health, derived.errorCode),
    oauth: derived.oauth,
    connected: derived.connected,
    status: derived.status,
    ...(derived.errorCode ? { errorCode: derived.errorCode } : {}),
  };
}

export function normalizeConnectorFailure(err: unknown): {
  code: ConnectorErrorCode;
  message: string;
  health: ConnectorHealth;
  nextStep: string;
  status: number;
} {
  if (err instanceof ConnectorError) {
    return {
      code: err.code,
      message: redactDiagnosticValue(err.message),
      health: healthForErrorCode(err.code),
      nextStep: nextStepFor(healthForErrorCode(err.code), err.code),
      status: err.status,
    };
  }
  const raw = err instanceof Error ? err.message : String(err ?? "connector error");
  const message = redactDiagnosticValue(raw);
  const lower = message.toLowerCase();
  let code: ConnectorErrorCode = "upstream";
  if (err && typeof err === "object" && (err as { name?: string }).name === "TimeoutError") code = "timeout";
  else if (/\btimeout\b|aborted|abort error/.test(lower)) code = "timeout";
  else if (/no composio|not configured|no api key/.test(lower)) code = "not_configured";
  else if (/already connected|identity already claimed|identity_collision/.test(lower)) code = "identity_collision";
  else if (/401|403|unauthorized|invalid.?grant|expired|revoked|stale/.test(lower)) code = "auth_stale";
  else if (/denied|auth(?:orization)? failed/.test(lower)) code = "auth_failed";
  const health = healthForErrorCode(code);
  return {
    code,
    message,
    health,
    nextStep: nextStepFor(health, code),
    status: httpStatusForConnectorCode(code),
  };
}

// ── OAuth lifecycle (in-process; hub is the one store) ────────────────

const oauthByKey = new Map<string, ConnectorOAuthRecord>();

export function markOAuth(
  input: { botId?: string; slug: string; identity?: string },
  phase: ConnectorOAuthPhase,
  health?: ConnectorHealth,
): ConnectorOAuthRecord {
  const slug = normalizeSlug(input.slug);
  const key = oauthStorageKey(input.botId, slug);
  const record: ConnectorOAuthRecord = {
    botId: String(input.botId ?? "_").trim() || "_",
    slug,
    identity: input.identity ?? slug,
    phase,
    ...(health ? { health } : {}),
  };
  oauthByKey.set(key, record);
  return record;
}

export function oauthRecord(botId: string | undefined, slug: string): ConnectorOAuthRecord | undefined {
  return oauthByKey.get(oauthStorageKey(botId, slug));
}

export function clearOAuth(botId: string | undefined, slug: string): void {
  oauthByKey.delete(oauthStorageKey(botId, slug));
}

// ── Tool-list cache ───────────────────────────────────────────────────

let toolListGeneration = 0;
const toolListCache = new Map<string, { generation: number; tools: unknown[] }>();

export function currentToolListGeneration(): number {
  return toolListGeneration;
}

export function invalidateToolLists(reason: ToolListInvalidateReason): number {
  void reason;
  toolListGeneration += 1;
  toolListCache.clear();
  return toolListGeneration;
}

export function cacheToolList(identity: string, tools: unknown[], generation = toolListGeneration): void {
  const id = String(identity ?? "").trim();
  if (!id) return;
  toolListCache.set(id, { generation, tools: Array.isArray(tools) ? tools.slice() : [] });
}

export function cachedToolList(identity: string, generation = toolListGeneration): unknown[] | null {
  const hit = toolListCache.get(String(identity ?? "").trim());
  if (!hit || hit.generation !== generation) return null;
  return hit.tools.slice();
}

export function shouldInvalidateToolList(failure: { code?: ConnectorErrorCode; health?: ConnectorHealth }): boolean {
  return failure.code === "auth_stale" || failure.code === "auth_failed" || failure.health === "stale";
}

// ── Redacted diagnostics ──────────────────────────────────────────────

const DIAGNOSTIC_VALUE_PATTERNS: Array<[RegExp, string]> = [
  [/\bBearer\s+\S+/gi, "Bearer «redacted»"],
  [/\b(Cookie|Set-Cookie)\s*:\s*[^\r\n]+/gi, "$1: «redacted»"],
  [/\bclient[_-]?secret\s*[:=]\s*\S+/gi, "client_secret=«redacted»"],
  [/\b(?:access|refresh)[_-]?token\s*[:=]\s*\S+/gi, "token=«redacted»"],
  [/\b(?:ck|ak)_[A-Za-z0-9_-]{8,}/gi, "«redacted-key»"],
];

export function redactDiagnosticValue(text: string): string {
  let out = String(text ?? "");
  for (const [pattern, replacement] of DIAGNOSTIC_VALUE_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

export function redactConnectorDiagnostics<T>(input: T, depth = 0): T {
  if (depth > 12) return input;
  if (typeof input === "string") return redactDiagnosticValue(input) as T;
  if (input === null || typeof input !== "object") return input;
  const keyed = redactSecrets(input);
  if (typeof keyed === "string") return redactDiagnosticValue(keyed) as T;
  if (Array.isArray(keyed)) return keyed.map((item) => redactConnectorDiagnostics(item, depth + 1)) as T;
  if (!keyed || typeof keyed !== "object") return keyed as T;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(keyed as Record<string, unknown>)) {
    out[key] = redactConnectorDiagnostics(value, depth + 1);
  }
  return out as T;
}

export function publicConnectorFailure(err: unknown): {
  error: string;
  errorCode: ConnectorErrorCode;
  health: ConnectorHealth;
  nextStep: string;
} {
  const n = normalizeConnectorFailure(err);
  return {
    error: n.message,
    errorCode: n.code,
    health: n.health,
    nextStep: n.nextStep,
  };
}

/** Test hook — never call from production paths. */
export function resetConnectorLifecycleForTests(): void {
  oauthByKey.clear();
  toolListCache.clear();
  toolListGeneration = 0;
}
