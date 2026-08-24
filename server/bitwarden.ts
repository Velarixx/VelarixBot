// Optional Bitwarden Secrets Manager provider. Same altitude as Composio:
// honest-empty when unconfigured, never required at boot, credentials sealed
// via SecretStore, values never persisted. Access is an explicit per-bot
// allowlist of secret and/or project ids (default none).
import type { AppConfig } from "./config.ts";
import {
  decryptEncString,
  decryptEncStringUtf8,
  encryptEncString,
  organizationKeyFromPayload,
  parseAccessToken,
} from "./bitwarden-crypto.ts";
import { clearBitwardenSecretValues, rememberSecretValues } from "./redact-text.ts";
import { validStringList } from "./store.ts";

export const DEFAULT_BITWARDEN_IDENTITY_URL = "https://identity.bitwarden.com";
export const DEFAULT_BITWARDEN_API_URL = "https://api.bitwarden.com";

export type BitwardenConnectionStatus = "connected" | "disconnected" | "error";

export interface BitwardenProjectMeta {
  id: string;
  name: string;
}

export interface BitwardenSecretMeta {
  id: string;
  key: string;
  projectId?: string;
}

export interface BitwardenPublicStatus {
  configured: boolean;
  status: BitwardenConnectionStatus;
  nextStep: string;
  error?: string;
  projects: BitwardenProjectMeta[];
  secrets: BitwardenSecretMeta[];
}

export interface BitwardenAllowlist {
  secretIds: string[];
  projectIds: string[];
}

export interface ApprovedSecret {
  id: string;
  key: string;
  value: string;
  projectId?: string;
}

interface Session {
  generation: number;
  bearer: string;
  orgKey: Buffer;
  identityUrl: string;
  apiUrl: string;
}

interface EncryptedSecret {
  id: string;
  key: string;
  value: string;
  projectId?: string;
}

interface EncryptedProject {
  id: string;
  name: string;
}

let generation = 0;
let session: Session | null = null;

export function bitwardenConfigured(cfg: AppConfig): boolean {
  return Boolean(cfg.bitwarden?.accessToken?.trim());
}

export function dropBitwardenSession(): void {
  generation += 1;
  session = null;
  clearBitwardenSecretValues();
}

export function bitwardenAllowlist(bot: { bitwardenSecretIds?: string[]; bitwardenProjectIds?: string[] } | null | undefined): BitwardenAllowlist {
  return {
    secretIds: uniqueIds(bot?.bitwardenSecretIds),
    projectIds: uniqueIds(bot?.bitwardenProjectIds),
  };
}

export function parseBitwardenIdList(raw: unknown): string[] {
  return uniqueIds(validStringList(raw) ?? (typeof raw === "string" ? raw.split(/[,\s]+/) : []));
}

export function secretEnvName(key: string, id: string): string {
  const cleaned = key
    .trim()
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
  if (cleaned && /^[A-Z]/.test(cleaned) && cleaned !== "BWS_ACCESS_TOKEN") return cleaned;
  const suffix = id.replace(/-/g, "").slice(0, 12).toUpperCase() || "SECRET";
  return `BWS_${suffix}`;
}

export function approvedSecretEnv(secrets: ApprovedSecret[]): Record<string, string> {
  const env: Record<string, string> = {};
  const used = new Set<string>();
  for (const secret of secrets) {
    const name = secretEnvName(secret.key, secret.id);
    if (used.has(name) || name === "BWS_ACCESS_TOKEN") continue;
    used.add(name);
    env[name] = secret.value;
  }
  return env;
}

export function isSecretApproved(secret: { id: string; projectId?: string }, allow: BitwardenAllowlist): boolean {
  if (allow.secretIds.includes(secret.id)) return true;
  if (secret.projectId && allow.projectIds.includes(secret.projectId)) return true;
  return false;
}

export function publicBitwardenConfig(cfg: AppConfig): { configured: boolean } {
  return { configured: bitwardenConfigured(cfg) };
}

export async function bitwardenStatus(cfg: AppConfig): Promise<BitwardenPublicStatus> {
  if (!bitwardenConfigured(cfg)) {
    return {
      configured: false,
      status: "disconnected",
      nextStep: "Paste a Bitwarden Secrets Manager machine-account access token in App Settings, then Save.",
      projects: [],
      secrets: [],
    };
  }
  try {
    const catalog = await loadCatalog(cfg);
    return {
      configured: true,
      status: "connected",
      nextStep: "Approve secrets or projects per bot. Default is none. Disconnect clears the token immediately.",
      projects: catalog.projects,
      secrets: catalog.secrets,
    };
  } catch (e) {
    dropBitwardenSession();
    return {
      configured: true,
      status: "error",
      error: publicError(e),
      nextStep: "Check the access token, identity URL, and network, then save the token again.",
      projects: [],
      secrets: [],
    };
  }
}

/** Approved values for one bot. Empty allowlist or no token → none. Fail-closed. */
export async function fetchApprovedSecrets(
  cfg: AppConfig,
  bot: { bitwardenSecretIds?: string[]; bitwardenProjectIds?: string[] } | null | undefined,
): Promise<ApprovedSecret[]> {
  const allow = bitwardenAllowlist(bot);
  if (!bitwardenConfigured(cfg) || (!allow.secretIds.length && !allow.projectIds.length)) {
    return [];
  }
  const gen = generation;
  const catalog = await loadCatalog(cfg, { includeValues: true });
  if (gen !== generation) return [];
  const approved = catalog.valued.filter((secret) => isSecretApproved(secret, allow));
  rememberSecretValues(approved.map((secret) => secret.value));
  return approved;
}

export async function fetchApprovedSecretEnv(
  cfg: AppConfig,
  bot: { bitwardenSecretIds?: string[]; bitwardenProjectIds?: string[] } | null | undefined,
): Promise<{ env: Record<string, string>; keys: string[] }> {
  const approved = await fetchApprovedSecrets(cfg, bot);
  const env = approvedSecretEnv(approved);
  return { env, keys: Object.keys(env) };
}

function uniqueIds(raw: unknown): string[] {
  const listed = Array.isArray(raw) ? raw.map((item) => String(item).trim()).filter(Boolean) : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of listed) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function publicError(e: unknown): string {
  const message = e instanceof Error ? e.message : "Bitwarden request failed";
  return message.replace(/\b(0\.[0-9a-f-]{36}\.[A-Za-z0-9+/=:_-]+)\b/gi, "[redacted]").slice(0, 240);
}

function identityUrl(cfg: AppConfig): string {
  return trimUrl(cfg.bitwarden?.identityUrl) || DEFAULT_BITWARDEN_IDENTITY_URL;
}

function apiUrl(cfg: AppConfig): string {
  return trimUrl(cfg.bitwarden?.apiUrl) || DEFAULT_BITWARDEN_API_URL;
}

function trimUrl(value: string | undefined): string {
  return typeof value === "string" ? value.trim().replace(/\/+$/, "") : "";
}

async function ensureSession(cfg: AppConfig): Promise<Session> {
  const token = cfg.bitwarden?.accessToken?.trim();
  if (!token) throw new Error("Bitwarden is not connected");
  const parsed = parseAccessToken(token);
  const ident = identityUrl(cfg);
  const api = apiUrl(cfg);
  if (session && session.identityUrl === ident && session.apiUrl === api) return session;
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    scope: "api.secrets",
    client_id: parsed.accessTokenId,
    client_secret: parsed.clientSecret,
  });
  const res = await fetch(`${ident}/connect/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(statusHint(res.status, "identity"));
  let json: { access_token?: unknown; encrypted_payload?: unknown };
  try {
    json = JSON.parse(text) as { access_token?: unknown; encrypted_payload?: unknown };
  } catch {
    throw new Error("Bitwarden identity returned a non-JSON response");
  }
  if (typeof json.access_token !== "string" || typeof json.encrypted_payload !== "string") {
    throw new Error("Bitwarden identity response was incomplete");
  }
  const orgKey = organizationKeyFromPayload(decryptEncString(json.encrypted_payload, parsed.encryptionKey));
  session = { generation, bearer: json.access_token, orgKey, identityUrl: ident, apiUrl: api };
  return session;
}

function statusHint(status: number, which: "identity" | "api"): string {
  if (status === 401 || status === 403) return `Bitwarden ${which} rejected the access token`;
  if (status === 404) return `Bitwarden ${which} URL was not found`;
  return `Bitwarden ${which} returned HTTP ${status}`;
}

async function apiJson(session: Session, path: string): Promise<unknown> {
  const res = await fetch(`${session.apiUrl}${path}`, {
    headers: { authorization: `Bearer ${session.bearer}`, accept: "application/json" },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(statusHint(res.status, "api"));
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("Bitwarden API returned a non-JSON response");
  }
}

function listData(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object" && Array.isArray((raw as { data?: unknown }).data)) {
    return (raw as { data: unknown[] }).data;
  }
  return [];
}

function readEncryptedSecret(raw: unknown): EncryptedSecret | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  const id = typeof rec.id === "string" ? rec.id.trim() : "";
  const key = typeof rec.key === "string" ? rec.key : "";
  const value = typeof rec.value === "string" ? rec.value : "";
  if (!id || !key) return null;
  let projectId: string | undefined;
  if (typeof rec.projectId === "string" && rec.projectId.trim()) projectId = rec.projectId.trim();
  else if (Array.isArray(rec.projects)) {
    const first = rec.projects.find((item) => item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string");
    if (first && typeof (first as { id: string }).id === "string") projectId = (first as { id: string }).id.trim();
  }
  return { id, key, value, ...(projectId ? { projectId } : {}) };
}

function readEncryptedProject(raw: unknown): EncryptedProject | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  const id = typeof rec.id === "string" ? rec.id.trim() : "";
  const name = typeof rec.name === "string" ? rec.name : "";
  if (!id || !name) return null;
  return { id, name };
}

async function loadCatalog(
  cfg: AppConfig,
  opts: { includeValues?: boolean } = {},
): Promise<{ projects: BitwardenProjectMeta[]; secrets: BitwardenSecretMeta[]; valued: ApprovedSecret[] }> {
  const live = await ensureSession(cfg);
  const [secretsRaw, projectsRaw] = await Promise.all([apiJson(live, "/secrets"), apiJson(live, "/projects")]);
  const projects: BitwardenProjectMeta[] = [];
  for (const item of listData(projectsRaw)) {
    const enc = readEncryptedProject(item);
    if (!enc) continue;
    let name = enc.id;
    try {
      name = decryptEncStringUtf8(enc.name, live.orgKey);
    } catch {
      /* keep id as the label */
    }
    projects.push({ id: enc.id, name });
  }
  const secrets: BitwardenSecretMeta[] = [];
  const valued: ApprovedSecret[] = [];
  for (const item of listData(secretsRaw)) {
    const enc = readEncryptedSecret(item);
    if (!enc) continue;
    let key = enc.id;
    try {
      key = decryptEncStringUtf8(enc.key, live.orgKey);
    } catch {
      continue;
    }
    const meta: BitwardenSecretMeta = { id: enc.id, key, ...(enc.projectId ? { projectId: enc.projectId } : {}) };
    secrets.push(meta);
    if (!opts.includeValues || !enc.value) continue;
    try {
      valued.push({ ...meta, value: decryptEncStringUtf8(enc.value, live.orgKey) });
    } catch {
      /* skip undecryptable values — fail closed for that secret */
    }
  }
  return { projects, secrets, valued };
}

/** Test helper: encrypt catalog rows under a known org key (never used in prod). */
export function encryptCatalogForTests(orgKey: Buffer, plaintext: { key: string; value: string }): { key: string; value: string } {
  return { key: encryptEncString(plaintext.key, orgKey), value: encryptEncString(plaintext.value, orgKey) };
}

export function resetBitwardenForTests(): void {
  dropBitwardenSession();
  generation = 0;
}
