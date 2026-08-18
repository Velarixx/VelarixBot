// P1.7 export-diagnostics: one bundle a user (or support) can hand over —
// versions, capabilities, redacted logs, and an integrity result. NO
// transcripts: the log section is built exclusively from metadata-only
// queries (repositories/event-log.ts recentMeta never selects the payload
// column) and message/blob content has no code path into this file. API
// keys have none either — the bundle never reads config.json — and every
// string that does go out passes through redactSecrets as defense in depth.
//
// backupNow() is the one-click verified archive: a directory under
// ~/.velarixbot/backup/ with the SQLite snapshot PLUS approvals, skills,
// memory markdown, and config.json / secrets.json. Verified (integrity_check
// + row counts + per-file sha256) by db/backup.ts before it is reported.
// Manifest metadata never includes file contents or secret values.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { readAudit, redactSecrets } from "../approvals.ts";
import { DATA_DIR } from "../config.ts";
import { createVerifiedBackup, isBackupComplete, tableCounts, type BackupManifest } from "../db/backup.ts";
import type { Repositories } from "../repositories/index.ts";

export const DIAGNOSTICS_FORMAT = "velarixbot-diagnostics";
export const DIAGNOSTICS_VERSION = 1;
const LOG_TAIL = 200;

/** Structural slices of ProviderRegistry / ComputerRegistry — the service
 * needs only the describe/list surfaces, so tests can hand it plain objects. */
export interface DiagnosticsProviderSource {
  describe(): Promise<
    Array<{
      instanceId: string;
      driverKind: string;
      displayName: string;
      snapshot: { state: string; reason?: string; authenticated?: boolean; version?: string | null };
      models: { default: string; options: Array<{ id: string; label: string }> };
    }>
  >;
}

export interface DiagnosticsComputerSource {
  list(): ReadonlyArray<{ id: string; kind: string; displayName: string; capabilities: unknown }>;
}

export interface DiagnosticsBundle {
  format: typeof DIAGNOSTICS_FORMAT;
  version: typeof DIAGNOSTICS_VERSION;
  generatedAt: string;
  /** Always false: transcripts (messages, event payloads, screenshots) are
   * excluded by default and this export has no way to include them. */
  transcriptsIncluded: false;
  versions: {
    app: string;
    node: string;
    platform: string;
    arch: string;
    schemaVersion: number;
    stamp: string;
  };
  capabilities: {
    providers: Array<{
      instanceId: string;
      driverKind: string;
      displayName: string;
      state: string;
      reason?: string;
      version?: string | null;
      defaultModel: string;
      models: string[];
    }>;
    computers: Array<{ id: string; kind: string; displayName: string; capabilities: unknown }>;
  };
  integrity: {
    result: string;
    tables: Record<string, number>;
  };
  logs: {
    /** Newest events, metadata only (type + ids + timestamps — no payloads). */
    events: Array<{ seq: number; eventId: string; threadId: string; type: string; createdAt: string; streamId: string; sequence: number }>;
    eventsTotal: number;
    /** Approval decisions — matchers are redacted at write time already. */
    approvalAudit: Array<{ at: number; bot: string; tool: string; matcher: string; decision: string; ruleId?: string }>;
  };
}

export interface DiagnosticsService {
  exportBundle(): Promise<DiagnosticsBundle>;
  /** One-click verified archive: snapshot the profile (db + file-
   * authoritative domains + config/secrets) into ~/.velarixbot/backup/
   * and return the proven manifest. `complete` is the green-check gate. */
  backupNow(): { path: string; manifest: BackupManifest; complete: boolean };
}

function detectAppVersion(): string {
  if (process.env.VELARIX_APP_VERSION) return process.env.VELARIX_APP_VERSION;
  try {
    // dev / CI: the repo root package.json two levels up from server/services
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version?: string };
    if (typeof pkg.version === "string") return pkg.version;
  } catch {
    /* packaged installs pass VELARIX_APP_VERSION instead */
  }
  return "unknown";
}

/** Redact every string in a JSON-shaped value, leaf by leaf (never across
 * the serialized form, where a greedy pattern could eat structure). */
export function redactDeep<T>(value: T): T {
  if (typeof value === "string") return redactSecrets(value) as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v);
    return out as T;
  }
  return value;
}

export function createDiagnosticsService(deps: {
  repos: Repositories;
  providers: DiagnosticsProviderSource;
  computers: DiagnosticsComputerSource;
  stamp: string;
  now?: () => number;
}): DiagnosticsService {
  const { repos, providers, computers, stamp } = deps;
  const now = deps.now ?? (() => Date.now());

  return {
    async exportBundle() {
      const described = await providers.describe();
      const schemaVersion =
        (repos.db.prepare<{ v: number }>("SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations").get()?.v as number) ?? 0;
      const bundle: DiagnosticsBundle = {
        format: DIAGNOSTICS_FORMAT,
        version: DIAGNOSTICS_VERSION,
        generatedAt: new Date(now()).toISOString(),
        transcriptsIncluded: false,
        versions: {
          app: detectAppVersion(),
          node: process.version,
          platform: process.platform,
          arch: process.arch,
          schemaVersion,
          stamp,
        },
        capabilities: {
          providers: described.map((d) => ({
            instanceId: d.instanceId,
            driverKind: d.driverKind,
            displayName: d.displayName,
            state: d.snapshot.state,
            ...(d.snapshot.reason ? { reason: d.snapshot.reason } : {}),
            ...(d.snapshot.version !== undefined ? { version: d.snapshot.version } : {}),
            defaultModel: d.models.default,
            models: d.models.options.map((o) => o.id),
          })),
          computers: computers.list().map((p) => ({
            id: p.id,
            kind: p.kind,
            displayName: p.displayName,
            capabilities: p.capabilities,
          })),
        },
        integrity: {
          result: String(repos.db.pragma("integrity_check", { simple: true })),
          tables: tableCounts(repos.db),
        },
        logs: {
          events: repos.eventLog.recentMeta(LOG_TAIL),
          eventsTotal: repos.eventLog.count(),
          approvalAudit: readAudit().slice(-LOG_TAIL),
        },
      };
      return redactDeep(bundle);
    },

    backupNow() {
      const timestamp = new Date(now()).toISOString().replace(/[:.]/g, "-");
      // two backups in the same millisecond get distinct names, never a throw
      let path = join(DATA_DIR, "backup", `velarixbot-${timestamp}`);
      for (let n = 2; existsSync(path); n++) path = join(DATA_DIR, "backup", `velarixbot-${timestamp}-${n}`);
      const manifest = createVerifiedBackup(repos.db, path);
      return { path, manifest, complete: isBackupComplete(manifest) };
    },
  };
}
