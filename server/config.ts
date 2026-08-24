// Config + data dirs. One file, ~/.velarixbot/config.json, env fallbacks:
//   { "xai": {"key":"secret://xai.key"}, "composio": {"key":"secret://composio.key"},
//     "box": {"token":"secret://box.token"},
//     "instances": { "<instanceId>": {"driver":"grok", …} } }
//
// P1.5: config.json holds secret:// REFERENCES for API keys/tokens, never the
// values — those live in the SecretStore (server/secrets.ts: OS keychain via
// Electron safeStorage, or the documented 0600 secrets.json fallback when
// headless). loadConfig() resolves refs into the in-memory AppConfig; saveConfig
// seals incoming plaintext into the store and writes refs; a pre-P1.5
// config.json with plaintext keys is migrated on boot (migrateConfigSecrets).
import { readFileSync, existsSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { atomicWriteFileSync, ensurePrivateDir } from "./atomic.ts";
import type { InstanceConfig, InstanceConfigMap } from "./contracts.ts";
import { isSecretRef, secretStore } from "./secrets.ts";

export interface AppConfig {
  xai?: { key?: string; url?: string };
  /** key = ck_… Connect consumer key (optional — connections when no Session);
   * apiKey = ak_… project API key — Sessions path + full toolkit catalog.
   * backendUrl overrides the v3.1 API base (tests). url is Connect MCP. */
  composio?: { key?: string; apiKey?: string; url?: string; backendUrl?: string };
  /** token/url are the vendor credentials. shared/namePrefix/leaseWaitMs are
   * the shared-box knobs (3.2.4/D3/D4, decoded strictly in server/box.ts):
   * shared = one cloud box for every bot in this install; namePrefix scopes
   * this install's box names when a team shares one Box account (one API key
   * per person, one prefix per install); leaseWaitMs is how long a turn
   * queues for the shared box before failing loud (default 10 min). */
  box?: { token?: string; url?: string; shared?: boolean; namePrefix?: string; leaseWaitMs?: number };
  /** Personal GitHub token. Write-only. Updater + GitHub listener polls. */
  github?: { token?: string };
  /** OpenAI BYO key (sk-…). Write-only. Used by A2 avatar generate. */
  openai?: { key?: string; url?: string };
  /** OpenRouter BYO key (sk-or-…). Write-only. */
  openrouter?: { key?: string; url?: string };
  /** OmniRouter BYO key. Write-only. Optional url for a self-hosted gateway. */
  omnirouter?: { key?: string; url?: string };
  /** Optional Telegram chat interface. token is write-only (SecretStore).
   * enabled/defaultBotId/allowlist are settings, not secrets. Default is
   * disconnected; an empty allowlist authorizes nobody. */
  telegram?: {
    token?: string;
    enabled?: boolean;
    defaultBotId?: string;
    allowlist?: string[];
  };

  instances?: InstanceConfigMap;

  /** Computer provider bindings (P1.1). An authored `providers` map — even
   * an empty one — replaces the bundled default ({ box: {kind:"box"} }), so
   * removing Box is `{"computer":{"providers":{}}}`. The `local` provider is
   * core and always registered. `kind` is any slug — unknown kinds surface
   * as unavailable shadow providers, never a crash. */
  computer?: { providers?: ComputerProviderConfigMap };
}

export type ComputerProviderConfigMap = Record<string, { kind: string; config?: unknown }>;

export const DATA_DIR = join(homedir(), ".velarixbot");
const LEGACY_DATA_DIRS = [join(homedir(), ".openmausbot"), join(homedir(), ".opengrokbot")];
export const EVENTS_DIR = join(DATA_DIR, "events");
export const NATIVE_DIR = join(DATA_DIR, "native");

/** Per-bot working directory. Codex sandbox `workspace-write` is this tree, not $HOME. */
export function botWorkspaceDir(botId: string): string {
  return join(DATA_DIR, "workspaces", botId);
}

export function ensureBotWorkspace(botId: string): string {
  const dir = botWorkspaceDir(botId);
  ensurePrivateDir(dir);
  return dir;
}

export function ensureDirs() {
  // one-time migration from the pre-rename data dir — bots, transcripts,
  // config and keys all carry over
  if (!existsSync(DATA_DIR)) {
    const legacy = LEGACY_DATA_DIRS.find((dir) => existsSync(dir));
    if (legacy) {
      try {
        renameSync(legacy, DATA_DIR);
      } catch {
        /* cross-device or busy — fall through to a fresh dir */
      }
    }
  }
  // user-private data: 0700 dirs (transcripts, keys, approval rules live here)
  for (const dir of [DATA_DIR, EVENTS_DIR, NATIVE_DIR, join(DATA_DIR, "memory")]) ensurePrivateDir(dir);
}

// The fields that are secrets. Everything else in these sections (urls, …)
// stays plaintext in config.json. The SecretStore id is `<section>.<prop>`.
export const SECRET_FIELDS = [
  { section: "xai", prop: "key" },
  { section: "composio", prop: "key" },
  { section: "composio", prop: "apiKey" },
  { section: "box", prop: "token" },
  { section: "github", prop: "token" },
  { section: "openai", prop: "key" },
  { section: "openrouter", prop: "key" },
  { section: "omnirouter", prop: "key" },
  { section: "telegram", prop: "token" },
] as const;

const CONFIG_SECTIONS = ["xai", "composio", "box", "github", "openai", "openrouter", "omnirouter", "telegram"] as const;

export function loadConfig(): AppConfig {
  let cfg: AppConfig = {};
  try {
    cfg = JSON.parse(readFileSync(join(DATA_DIR, "config.json"), "utf8"));
  } catch {
    /* first run — env fallbacks below */
  }
  resolveSecretRefs(cfg as Record<string, unknown>);
  cfg.xai = { key: process.env.XAI_API_KEY, ...cfg.xai };
  cfg.composio = { key: process.env.COMPOSIO_KEY, ...cfg.composio };
  cfg.box = { token: process.env.BOX_TOKEN, ...cfg.box };
  cfg.github = { token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN, ...cfg.github };
  cfg.openai = { key: process.env.OPENAI_API_KEY, url: process.env.OPENAI_BASE_URL, ...cfg.openai };
  cfg.openrouter = { key: process.env.OPENROUTER_API_KEY, url: process.env.OPENROUTER_BASE_URL, ...cfg.openrouter };
  cfg.omnirouter = { key: process.env.OMNIROUTER_API_KEY, url: process.env.OMNIROUTER_BASE_URL, ...cfg.omnirouter };
  return cfg;
}

/** In-memory AppConfig carries resolved values; disk carries refs. A ref this
 * process cannot unseal (keychain entry, running headless) is dropped so the
 * field reads unconfigured and the env fallback can still apply. */
function resolveSecretRefs(cfg: Record<string, unknown>): void {
  const store = secretStore();
  for (const { section, prop } of SECRET_FIELDS) {
    const sec = cfg[section];
    if (!sec || typeof sec !== "object") continue;
    const rec = sec as Record<string, unknown>;
    if (!isSecretRef(rec[prop])) continue;
    const resolved = store.resolve(rec[prop] as string);
    if (resolved === undefined) delete rec[prop];
    else rec[prop] = resolved;
  }
}

/** Seal plaintext secret fields of a disk-shaped config object into the
 * SecretStore, replacing them with secret:// refs. An empty string means
 * "clear": the ref is dropped from config.json AND the stored secret is
 * deleted. Mutates `disk`. */
async function sealSecretFields(disk: Record<string, unknown>): Promise<void> {
  const store = secretStore();
  for (const { section, prop } of SECRET_FIELDS) {
    const sec = disk[section];
    if (!sec || typeof sec !== "object") continue;
    const rec = sec as Record<string, unknown>;
    const value = rec[prop];
    if (typeof value !== "string" || isSecretRef(value)) continue;
    const id = `${section}.${prop}`;
    if (!value.trim()) {
      delete rec[prop];
      store.remove(id);
      continue;
    }
    rec[prop] = await store.put(id, value);
  }
}

/** Merge a partial config into ~/.velarixbot/config.json (secrets never
 * echoed back — callers report configured-or-not booleans only). Secret
 * fields are sealed into the SecretStore; config.json gets secret:// refs. */
export async function saveConfig(patch: Partial<AppConfig>): Promise<void> {
  const p = join(DATA_DIR, "config.json");
  let disk: Record<string, unknown> = {};
  try {
    disk = JSON.parse(readFileSync(p, "utf8"));
  } catch {
    /* first write */
  }
  for (const key of CONFIG_SECTIONS) {
    if (patch[key] && typeof patch[key] === "object") {
      disk[key] = { ...(disk[key] as object), ...patch[key] };
    }
  }
  // [VERIFY] 2026-08-17: file-only decodeConfig({ cli }) already worked;
  // saveConfig dropped instances (CONFIG_SECTIONS only). Persisting the
  // full map is required so PATCH /api/instances/:id cannot wipe the fleet.
  // Callers that write this field must send the full persistable map —
  // a non-empty instances object replaces the default fleet.
  if (patch.instances && typeof patch.instances === "object") {
    disk.instances = persistableInstanceMap(patch.instances);
  }
  // every save also re-seals any plaintext still sitting in other sections
  await sealSecretFields(disk);
  ensurePrivateDir(DATA_DIR);
  // config.json holds secret refs + urls: 0600, fsynced, never torn mid-write
  atomicWriteFileSync(p, JSON.stringify(disk, null, 2));
}

/** One-time boot migration for a pre-P1.5 config.json: move plaintext API
 * keys/tokens into the SecretStore and rewrite the file with secret:// refs.
 * Idempotent — a fully-migrated file is left untouched. */
export async function migrateConfigSecrets(): Promise<boolean> {
  const p = join(DATA_DIR, "config.json");
  let disk: Record<string, unknown>;
  try {
    disk = JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return false; /* no config yet — nothing to migrate */
  }
  if (!disk || typeof disk !== "object") return false;
  const before = JSON.stringify(disk);
  await sealSecretFields(disk);
  if (JSON.stringify(disk) === before) return false;
  atomicWriteFileSync(p, JSON.stringify(disk, null, 2));
  return true;
}

// Default fleet: one instance per built-in driver (upstream
// defaultInstanceIdForDriver — instanceId defaults to the driver kind).
// Config-file keys are injected as per-instance environment so drivers
// see them without needing real process env vars.
/** Drop subprocess `environment` (secrets) before writing instances to disk. */
export function persistableInstanceMap(map: InstanceConfigMap): InstanceConfigMap {
  const out: InstanceConfigMap = {};
  for (const [id, entry] of Object.entries(map)) {
    if (!entry || typeof entry !== "object") continue;
    const { environment: _env, ...rest } = entry;
    out[id] = { ...rest };
  }
  return out;
}

/** Default fleet literal — instanceConfigs uses this when the user has not
 * authored a non-empty instances map. */
export function defaultInstanceMap(): InstanceConfigMap {
  return {
    grok: { driver: "grokAgent" },
    gemini: { driver: "geminiAgent" },
    claude: { driver: "claudeAgent" },
    codex: { driver: "codex" },
    hermes: { driver: "hermesAgent" },
    computer: { driver: "boxAgent" },
    openrouter: { driver: "openrouter" },
    omnirouter: { driver: "omnirouter" },
  };
}

/** Current fleet as a persistable map (no env secrets). Used when Settings
 * sets one CLI path so we do not replace the fleet with a single instance. */
export function persistableFleet(cfg: AppConfig): InstanceConfigMap {
  const source =
    cfg.instances && Object.keys(cfg.instances).length ? { ...cfg.instances } : defaultInstanceMap();
  return persistableInstanceMap(source);
}

export function instanceConfigs(cfg: AppConfig): InstanceConfigMap {
  // The default `grok` instance rides the `grokAgent` driver, not the API-key
  // one: like claude and codex it needs no credential from us, just the CLI
  // installed and logged in (it shows up unavailable otherwise). The API-key
  // `grok` driver stays registered but out of the default fleet — that key is
  // a credential the default fleet does not manage; an `instances` entry
  // brings it back anytime.
  const map: InstanceConfigMap =
    cfg.instances && Object.keys(cfg.instances).length
      ? { ...cfg.instances }
      : defaultInstanceMap();
  if (!map.openrouter) map.openrouter = { driver: "openrouter" };
  if (!map.omnirouter) map.omnirouter = { driver: "omnirouter" };
  map.openrouter = withOptionalUrl(map.openrouter, cfg.openrouter?.url);
  map.omnirouter = withOptionalUrl(map.omnirouter, cfg.omnirouter?.url);
  for (const entry of Object.values(map)) {
    entry.environment = {
      ...(DRIVER_SECRET_ENV[entry.driver]?.(cfg) ?? {}),
      ...entry.environment,
    };
  }
  return map;
}

// A subprocess env gets only the secret(s) its driver actually reads —
// never the whole key ring. CLI-login drivers (grokAgent, claudeAgent,
// codex, …) take no key from us at all. A user-authored instance
// `environment` always wins and passes through untouched.
const DRIVER_SECRET_ENV: Record<string, (cfg: AppConfig) => Record<string, string>> = {
  grok: (c) => envIf("XAI_API_KEY", c.xai?.key),
  boxAgent: (c) => envIf("BOX_TOKEN", c.box?.token),
  openrouter: (c) => envIf("OPENROUTER_API_KEY", c.openrouter?.key),
  omnirouter: (c) => envIf("OMNIROUTER_API_KEY", c.omnirouter?.key),
};

function envIf(name: string, value: string | undefined): Record<string, string> {
  return value ? { [name]: value } : {};
}

function withOptionalUrl(entry: InstanceConfig, url: string | undefined): InstanceConfig {
  if (!url) return entry;
  const existing =
    entry.config && typeof entry.config === "object" && !Array.isArray(entry.config)
      ? (entry.config as Record<string, unknown>)
      : {};
  if (typeof existing.url === "string") return entry;
  return { ...entry, config: { ...existing, url } };
}
