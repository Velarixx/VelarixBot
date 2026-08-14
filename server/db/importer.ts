// One-time transactional import of the legacy per-file JSON store into
// SQLite, plus the every-boot snapshot refresh for the domains whose
// runtime stays on their tested file modules (approvals, skills, memory).
//
// Contract (P0.4):
//   - backup first: every source file is copied (fsynced, 0600) into
//     ~/.velarixbot/backup/<stamp>/ before anything is written to SQLite
//   - ids and timestamps are preserved verbatim
//   - the whole import is ONE transaction, verified by checksum against a
//     re-read of the database BEFORE the commit — any mismatch rolls back
//   - rerunnable: completion is recorded in schema_migrations (version 0,
//     data migration); a rerun is a no-op
//   - the original JSON files are never modified or deleted
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { loadRules, readAudit, WORKSPACE_SCOPE } from "../approvals.ts";
import { atomicWriteFileSync, ensurePrivateDir } from "../atomic.ts";
import { DATA_DIR, EVENTS_DIR } from "../config.ts";
import type { RuntimeEvent } from "../contracts.ts";
import { MEMORY_DIR, readBotMemory, readWorkspace } from "../memory.ts";
import type { Repositories } from "../repositories/index.ts";
import type { MemoryRow, ScopedRule } from "../repositories/snapshots.ts";
import { normalizeBot, normalizeMessage, normalizeRoutine, type BotRecord, type Message, type RoutineRecord } from "../store.ts";
import { loadSkills } from "../teach.ts";
import { isApplied, recordApplied } from "./migrations.ts";

export const IMPORT_MIGRATION_NAME = "import-legacy-json";

export interface ImportResult {
  imported: boolean;
  skipped?: "already-imported" | "database-not-empty";
  backupDir?: string;
  checksum?: string;
  counts?: Record<string, number>;
}

// ── source reading (read-only: originals are never rewritten) ───────────
function readJsonArray(path: string): unknown[] {
  for (const candidate of [path, `${path}.bak`]) {
    try {
      const v: unknown = JSON.parse(readFileSync(candidate, "utf8"));
      if (Array.isArray(v)) return v;
    } catch {
      /* try the backup, then give up */
    }
  }
  return [];
}

interface LegacySources {
  files: string[]; // relative to DATA_DIR — the backup manifest
  bots: BotRecord[];
  routines: RoutineRecord[];
  /** threadId → ordered messages */
  messages: Map<string, Message[]>;
  /** threadId → ordered runtime events */
  events: Map<string, RuntimeEvent[]>;
  rules: ScopedRule[];
  audit: ReturnType<typeof readAudit>;
  skills: ReturnType<typeof loadSkills>;
  memory: MemoryRow[];
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

export function approvalScopesOnDisk(): string[] {
  return listDir(join(DATA_DIR, "approvals"))
    .filter((name) => name.endsWith(".json") && !name.endsWith(".bak"))
    .map((name) => name.slice(0, -".json".length));
}

export function memoryOwnersOnDisk(): string[] {
  return listDir(MEMORY_DIR)
    .filter((name) => name.endsWith(".md") && name !== "workspace.md")
    .map((name) => name.slice(0, -".md".length));
}

function collectMemoryRows(now: number): MemoryRow[] {
  const rows: MemoryRow[] = [];
  const workspace = readWorkspace();
  if (workspace) rows.push({ owner: WORKSPACE_SCOPE, user: workspace, distilled: "", updatedAt: now });
  for (const owner of memoryOwnersOnDisk()) {
    const { user, distilled } = readBotMemory(owner);
    if (!user && !distilled) continue;
    rows.push({ owner, user, distilled, updatedAt: now });
  }
  return rows;
}

// The snapshot tables round-trip exactly the columns they store, so the
// collected records are projected onto those fields (an exotic extra key in
// a legacy line must not fail the integrity checksum).
function collectScopedRules(): ScopedRule[] {
  const out: ScopedRule[] = [];
  for (const scope of approvalScopesOnDisk()) {
    for (const rule of loadRules(scope)) {
      out.push({
        scope,
        rule: {
          id: rule.id,
          tool: rule.tool,
          pattern: rule.pattern,
          action: rule.action,
          createdAt: rule.createdAt,
          ...(rule.disabled === true ? { disabled: true } : {}),
          ...(rule.quarantined === true ? { quarantined: true } : {}),
          ...(rule.confirmed === true ? { confirmed: true } : {}),
        },
      });
    }
  }
  return out;
}

function collectAudit(): LegacySources["audit"] {
  return readAudit().map((entry) => ({
    at: entry.at,
    bot: entry.bot,
    tool: entry.tool,
    matcher: entry.matcher,
    decision: entry.decision,
    ...(entry.ruleId ? { ruleId: entry.ruleId } : {}),
  }));
}

function collectSkills(): LegacySources["skills"] {
  return loadSkills().map((skill) => ({
    id: skill.id,
    name: skill.name,
    botId: skill.botId,
    markdown: skill.markdown,
    createdAt: skill.createdAt,
  }));
}

function collectLegacySources(now: number): LegacySources {
  const files: string[] = [];
  const track = (rel: string): boolean => {
    if (!existsSync(join(DATA_DIR, rel))) return false;
    files.push(rel);
    return true;
  };

  const bots = track("bots.json") ? readJsonArray(join(DATA_DIR, "bots.json")).map((b) => normalizeBot(b)).filter((b): b is BotRecord => !!b) : [];
  const routines = track("routines.json")
    ? readJsonArray(join(DATA_DIR, "routines.json")).map(normalizeRoutine).filter((r): r is RoutineRecord => !!r)
    : [];

  const messages = new Map<string, Message[]>();
  for (const name of listDir(DATA_DIR)) {
    const match = /^messages-(.+)\.json$/.exec(name);
    if (!match) continue;
    track(name);
    const list = readJsonArray(join(DATA_DIR, name)).map(normalizeMessage).filter((m): m is Message => !!m);
    messages.set(match[1], list);
  }

  const events = new Map<string, RuntimeEvent[]>();
  for (const name of listDir(EVENTS_DIR)) {
    const match = /^(.+)\.ndjson$/.exec(name);
    if (!match) continue;
    track(join("events", name));
    const list: RuntimeEvent[] = [];
    for (const line of readFileSync(join(EVENTS_DIR, name), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as RuntimeEvent;
        if (parsed && typeof parsed.type === "string") list.push({ ...parsed, threadId: parsed.threadId ?? match[1] });
      } catch {
        /* a torn trailing line is expected after a crash — skip it */
      }
    }
    events.set(match[1], list);
  }

  track("skills.json");
  for (const scope of approvalScopesOnDisk()) track(join("approvals", `${scope}.json`));
  track(join("approvals", "audit.jsonl"));
  track(join("memory", "workspace.md"));
  for (const owner of memoryOwnersOnDisk()) track(join("memory", `${owner}.md`));

  return {
    files,
    bots,
    routines,
    messages,
    events,
    rules: collectScopedRules(),
    audit: collectAudit(),
    skills: collectSkills(),
    memory: collectMemoryRows(now),
  };
}

// ── canonical checksum (stable across key order) ─────────────────────────
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** png payloads are compared by content hash so base64 canonicalization
 * differences can never fake a mismatch (bytes are what matter). */
function messageFingerprint(message: Message): unknown {
  if (typeof message.png === "string" && message.png) {
    const { png, ...rest } = message;
    return { ...rest, png: `sha256:${createHash("sha256").update(Buffer.from(png, "base64")).digest("hex")}` };
  }
  return message;
}

function sourcesChecksum(sources: {
  bots: BotRecord[];
  routines: RoutineRecord[];
  messages: Map<string, Message[]>;
  events: Map<string, RuntimeEvent[]>;
  rules: ScopedRule[];
  audit: LegacySources["audit"];
  skills: LegacySources["skills"];
  memory: MemoryRow[];
}): string {
  const threads = [...sources.messages.keys()].sort();
  const eventThreads = [...sources.events.keys()].sort();
  return sha256Hex(
    canonicalJson({
      bots: sources.bots,
      routines: sources.routines,
      messages: threads.map((t) => [t, sources.messages.get(t)!.map(messageFingerprint)]),
      events: eventThreads.map((t) => [t, sources.events.get(t)]),
      rules: sources.rules,
      audit: sources.audit,
      skills: sources.skills,
      memory: sources.memory,
    }),
  );
}

// ── backup ───────────────────────────────────────────────────────────────
export function backupLegacyFiles(files: string[], stamp: string): string | undefined {
  if (!files.length) return undefined;
  const backupRoot = join(DATA_DIR, "backup", stamp);
  for (const rel of files) {
    const source = join(DATA_DIR, rel);
    let bytes: Buffer;
    try {
      bytes = readFileSync(source);
    } catch {
      continue;
    }
    const target = join(backupRoot, rel);
    ensurePrivateDir(join(target, ".."));
    atomicWriteFileSync(target, bytes);
  }
  return backupRoot;
}

// ── snapshot refresh (every boot; rerunnable by construction) ────────────
export function refreshSnapshots(repos: Repositories, now = Date.now()): void {
  repos.db.transaction(() => {
    repos.snapshots.replaceApprovalRules(collectScopedRules());
    repos.snapshots.replaceApprovalAudit(collectAudit());
    repos.snapshots.replaceSkills(collectSkills());
    repos.snapshots.replaceMemory(collectMemoryRows(now));
  })();
}

// ── the import ───────────────────────────────────────────────────────────
export function importLegacyData(repos: Repositories, opts: { now?: number; backupStamp?: string } = {}): ImportResult {
  const db = repos.db;
  const now = opts.now ?? Date.now();

  if (isApplied(db, IMPORT_MIGRATION_NAME)) {
    refreshSnapshots(repos, now);
    return { imported: false, skipped: "already-imported" };
  }
  if (repos.bots.count() > 0) {
    // a database that already has live rows must never be clobbered by
    // stale JSON — mark the import done and move on
    recordApplied(db, { name: IMPORT_MIGRATION_NAME, version: 0, checksum: null, now });
    refreshSnapshots(repos, now);
    return { imported: false, skipped: "database-not-empty" };
  }

  const sources = collectLegacySources(now);
  const backupDir = backupLegacyFiles(
    sources.files,
    opts.backupStamp ?? `legacy-json-${new Date(now).toISOString().replace(/[:.]/g, "-")}`,
  );
  const checksum = sourcesChecksum(sources);

  const counts: Record<string, number> = {
    bots: sources.bots.length,
    routines: sources.routines.length,
    messages: [...sources.messages.values()].reduce((n, list) => n + list.length, 0),
    events: [...sources.events.values()].reduce((n, list) => n + list.length, 0),
    approvalRules: sources.rules.length,
    approvalAudit: sources.audit.length,
    skills: sources.skills.length,
    memory: sources.memory.length,
  };

  db.transaction(() => {
    // bots arrive newest-first on disk; insert oldest-first so seq order
    // reproduces the sidebar order
    for (const bot of [...sources.bots].reverse()) repos.bots.insert(bot);
    for (const routine of sources.routines) repos.routines.insert(routine);
    for (const [threadId, list] of sources.messages) {
      for (const message of list) repos.messages.append(threadId, { ...message, id: message.id, at: message.at });
    }
    for (const [, list] of sources.events) {
      for (const event of list) repos.eventLog.append(event);
    }
    repos.snapshots.replaceApprovalRules(sources.rules);
    repos.snapshots.replaceApprovalAudit(sources.audit);
    repos.snapshots.replaceSkills(sources.skills);
    repos.snapshots.replaceMemory(sources.memory);

    // integrity gate: re-read EVERYTHING from the database and compare the
    // canonical checksum before the transaction may commit
    const reread = {
      bots: repos.bots.list(),
      routines: repos.routines.list(),
      messages: new Map([...sources.messages.keys()].map((t) => [t, repos.messages.forThread(t)] as const)),
      events: new Map([...sources.events.keys()].map((t) => [t, repos.eventLog.forThread(t)] as const)),
      rules: repos.snapshots.listApprovalRules(),
      audit: repos.snapshots.listApprovalAudit(),
      skills: repos.snapshots.listSkills(),
      memory: repos.snapshots.listMemory(),
    };
    const rereadChecksum = sourcesChecksum(reread);
    if (rereadChecksum !== checksum) {
      throw new Error(`legacy import integrity check failed: source ${checksum} != database ${rereadChecksum}`);
    }
    recordApplied(db, { name: IMPORT_MIGRATION_NAME, version: 0, checksum, now });
  })();

  return { imported: true, backupDir, checksum, counts };
}
