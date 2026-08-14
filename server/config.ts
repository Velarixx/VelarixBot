// Config + data dirs. One file, ~/.velarixbot/config.json, env fallbacks:
//   { "xai": {"key":"xai-…"}, "composio": {"key":"ck_…"}, "box": {"token":"…"},
//     "openrouter": {"key":"sk-or-…"}, "omnirouter": {"key":"…"},
//     "instances": { "<instanceId>": {"driver":"grok", …} } }
import { readFileSync, existsSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { atomicWriteFileSync, ensurePrivateDir } from "./atomic.ts";
import type { InstanceConfig, InstanceConfigMap } from "./contracts.ts";

export interface AppConfig {
  xai?: { key?: string; url?: string };
  /** key = ck_… Connect consumer key (connections + agent tools);
   * apiKey = ak_… project API key — optional, unlocks the full toolkit
   * catalog with official logos in the plugins marketplace. */
  composio?: { key?: string; apiKey?: string; url?: string };
  box?: { token?: string; url?: string };
  /** Personal GitHub token for private VelarixBot Releases (updater). Write-only. */
  github?: { token?: string };
  /** OpenRouter BYO key (sk-or-…). Write-only. */
  openrouter?: { key?: string; url?: string };
  /** OmniRouter BYO key. Write-only. Optional url for a self-hosted gateway. */
  omnirouter?: { key?: string; url?: string };

  instances?: InstanceConfigMap;
}

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

export function loadConfig(): AppConfig {
  let cfg: AppConfig = {};
  try {
    cfg = JSON.parse(readFileSync(join(DATA_DIR, "config.json"), "utf8"));
  } catch {
    /* first run — env fallbacks below */
  }
  cfg.xai = { key: process.env.XAI_API_KEY, ...cfg.xai };
  cfg.composio = { key: process.env.COMPOSIO_KEY, ...cfg.composio };
  cfg.box = { token: process.env.BOX_TOKEN, ...cfg.box };
  cfg.github = { token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN, ...cfg.github };
  cfg.openrouter = { key: process.env.OPENROUTER_API_KEY, url: process.env.OPENROUTER_BASE_URL, ...cfg.openrouter };
  cfg.omnirouter = { key: process.env.OMNIROUTER_API_KEY, url: process.env.OMNIROUTER_BASE_URL, ...cfg.omnirouter };
  return cfg;
}

/** Merge a partial config into ~/.velarixbot/config.json (secrets never
 * echoed back — callers report configured-or-not booleans only). */
export function saveConfig(patch: Partial<AppConfig>): void {
  const p = join(DATA_DIR, "config.json");
  let disk: Record<string, unknown> = {};
  try {
    disk = JSON.parse(readFileSync(p, "utf8"));
  } catch {
    /* first write */
  }
  for (const key of ["xai", "composio", "box", "github", "openrouter", "omnirouter"] as const) {
    if (patch[key] && typeof patch[key] === "object") {
      disk[key] = { ...(disk[key] as object), ...patch[key] };
    }
  }
  ensurePrivateDir(DATA_DIR);
  // config.json holds raw API keys: 0600, fsynced, never torn mid-write
  atomicWriteFileSync(p, JSON.stringify(disk, null, 2));
}

// Default fleet: one instance per built-in driver (upstream
// defaultInstanceIdForDriver — instanceId defaults to the driver kind).
// Config-file keys are injected as per-instance environment so drivers
// see them without needing real process env vars.
export function instanceConfigs(cfg: AppConfig): InstanceConfigMap {
  // The default `grok` instance rides the `grokAgent` driver, not the API-key
  // one: like claude and codex it needs no credential from us, just the CLI
  // installed and logged in (it shows up unavailable otherwise). The API-key
  // `grok` driver stays registered but out of the default fleet — that key is
  // a credential Milind doesn't want to manage; an `instances` entry brings
  // it back anytime.
  const map: InstanceConfigMap =
    cfg.instances && Object.keys(cfg.instances).length
      ? { ...cfg.instances }
      : {
          grok: { driver: "grokAgent" },
          gemini: { driver: "geminiAgent" },
          claude: { driver: "claudeAgent" },
          codex: { driver: "codex" },
          // Hermes rides the CLI's own ChatGPT login (like claude/codex):
          // shows up unavailable until `hermes` is installed + signed in.
          // Default fleet only — a user-authored non-empty instances map
          // replaces this literal, and hermes is intentionally NOT on the
          // force-re-add list below (that stays openrouter/omnirouter only).
          hermes: { driver: "hermesAgent" },
          computer: { driver: "boxAgent" },
          openrouter: { driver: "openrouter" },
          omnirouter: { driver: "omnirouter" },
        };
  if (!map.openrouter) map.openrouter = { driver: "openrouter" };
  if (!map.omnirouter) map.omnirouter = { driver: "omnirouter" };
  map.openrouter = withOptionalUrl(map.openrouter, cfg.openrouter?.url);
  map.omnirouter = withOptionalUrl(map.omnirouter, cfg.omnirouter?.url);
  for (const entry of Object.values(map)) {
    entry.environment = {
      ...(cfg.xai?.key ? { XAI_API_KEY: cfg.xai.key } : {}),
      ...(cfg.box?.token ? { BOX_TOKEN: cfg.box.token } : {}),
      ...(cfg.openrouter?.key ? { OPENROUTER_API_KEY: cfg.openrouter.key } : {}),
      ...(cfg.omnirouter?.key ? { OMNIROUTER_API_KEY: cfg.omnirouter.key } : {}),
      ...entry.environment,
    };
  }
  return map;
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
