// Verified profile archive + restore-into-empty-profile. Source and
// target profiles are separate directories under the throwaway test home
// (Windows-safe: tmpdir + join via testing/setup.ts). Never touches the
// real ~/.velarixbot. No sleeps.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { addRule, loadRules } from "../approvals.ts";
import { DATA_DIR, saveConfig } from "../config.ts";
import { readWorkspace, writeWorkspace } from "../memory.ts";
import { createRepositories, type Repositories } from "../repositories/index.ts";
import { loadSkills, saveSkill } from "../teach.ts";
import {
  createVerifiedBackup,
  isBackupComplete,
  manifestPathFor,
  readBackupManifest,
  restoreBackupIntoEmptyProfile,
  tableCounts,
  type BackupManifest,
} from "./backup.ts";
import { openDatabase } from "./database.ts";
import { EXPORT_TABLES } from "./export.ts";
import { refreshSnapshots } from "./importer.ts";
import type { SqliteDatabase } from "./sqlite-native.ts";

const SOURCE_PROFILE = () => join(DATA_DIR, "profile-source");
const EMPTY_PROFILE = () => join(DATA_DIR, "profile-empty");
const SECRET_CANARY = "xai-backup-honesty-canary-never-echo";
const MEMORY_CANARY = "MEMORY-HONESTY-canary-must-survive-restore";
const SKILL_MARKDOWN = "# Honesty skill\n1. Keep the files.\n";

function populate(repos: Repositories): void {
  repos.bots.insert({
    id: "bot-1",
    threadId: "thread-1",
    name: "Backed Up",
    title: "",
    description: "",
    notifications: true,
    color: "blue",
    iconShape: "cursor",
    unread: false,
    modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
    resumeCursors: {},
    computer: "off",
    busy: false,
    state: "IDLE",
    usage: { input: 0, output: 0, cost: null },
    createdAt: 1_700_000_000_000,
  });
  repos.messages.append("thread-1", { role: "user", kind: "text", text: "survive the backup" });
  repos.messages.append("thread-1", { role: "bot", kind: "text", text: "acknowledged" });
  repos.eventLog.append({
    eventId: "ev-1",
    provider: "claudeAgent",
    threadId: "thread-1",
    createdAt: "2026-01-01T00:00:00Z",
    type: "turn.started",
  });
  repos.snapshots.replaceMemory([{ owner: "_workspace", user: "Notes.", distilled: "", updatedAt: 8 }]);
}

function dumpAll(db: SqliteDatabase): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const { table, columns } of EXPORT_TABLES) {
    out[table] = db.prepare(`SELECT ${columns.join(", ")} FROM ${table} ORDER BY rowid`).all();
  }
  return out;
}

function archiveDb(archiveDir: string): string {
  return join(archiveDir, "velarixbot.db");
}

describe("verified snapshot backup + restore into an empty profile", () => {
  let source: SqliteDatabase;
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    source = openDatabase(join(SOURCE_PROFILE(), "velarixbot.db"));
    populate(createRepositories(source));
  });
  afterEach(() => {
    try {
      source.close();
    } catch {
      /* already closed */
    }
  });

  it("creates a snapshot that is verified, not hoped: integrity ok, counts match, sha256 recorded", () => {
    const backupPath = join(DATA_DIR, "backup", "snap");
    const manifest = createVerifiedBackup(source, backupPath);

    expect(manifest.integrity).toBe("ok");
    expect(manifest.complete).toBe(true);
    expect(isBackupComplete(manifest)).toBe(true);
    expect(manifest.tables).toEqual(tableCounts(source));
    expect(manifest.tables.messages).toBe(2);
    expect(manifest.schemaVersion).toBeGreaterThanOrEqual(3);
    const actual = createHash("sha256").update(readFileSync(archiveDb(backupPath))).digest("hex");
    expect(manifest.sha256).toBe(actual);
    expect(JSON.parse(readFileSync(manifestPathFor(backupPath), "utf8"))).toEqual(manifest);
  });

  it("captures rows still sitting in the WAL (no checkpoint needed before backup)", () => {
    expect(existsSync(join(SOURCE_PROFILE(), "velarixbot.db-wal"))).toBe(true);
    const backupPath = join(DATA_DIR, "backup", "wal-snap");
    const manifest = createVerifiedBackup(source, backupPath);
    expect(manifest.tables.messages).toBe(2);
    expect(manifest.tables.bots).toBe(1);
  });

  it("restores into an empty profile and reproduces every table", () => {
    const backupPath = join(DATA_DIR, "backup", "snap");
    createVerifiedBackup(source, backupPath);

    const targetDbPath = join(EMPTY_PROFILE(), "velarixbot.db");
    const outcome = restoreBackupIntoEmptyProfile(backupPath, targetDbPath);
    expect(outcome.tables).toEqual(tableCounts(source));
    expect(outcome.complete).toBe(true);

    const restored = openDatabase(targetDbPath);
    try {
      expect(restored.pragma("integrity_check", { simple: true })).toBe("ok");
      expect(dumpAll(restored)).toEqual(dumpAll(source));
      const repos = createRepositories(restored);
      expect(repos.messages.forThread("thread-1").map((m) => m.text)).toEqual(["survive the backup", "acknowledged"]);
    } finally {
      restored.close();
    }
  });

  it("refuses to restore over a profile that already has a database", () => {
    const backupPath = join(DATA_DIR, "backup", "snap");
    createVerifiedBackup(source, backupPath);

    const occupied = join(EMPTY_PROFILE(), "velarixbot.db");
    const existing = openDatabase(occupied);
    existing.close();
    expect(() => restoreBackupIntoEmptyProfile(backupPath, occupied)).toThrow(/empty profile/);
  });

  it("rejects a tampered archive before touching the target profile", () => {
    const backupPath = join(DATA_DIR, "backup", "snap");
    createVerifiedBackup(source, backupPath);
    const dbPath = archiveDb(backupPath);
    const bytes = readFileSync(dbPath);
    bytes[Math.floor(bytes.length / 2)] ^= 0xff;
    writeFileSync(dbPath, bytes);

    const targetDbPath = join(EMPTY_PROFILE(), "velarixbot.db");
    expect(() => restoreBackupIntoEmptyProfile(backupPath, targetDbPath)).toThrow(/checksum mismatch/);
    expect(existsSync(targetDbPath)).toBe(false);
  });

  it("rejects a restore without its manifest (unverifiable archive)", () => {
    const backupPath = join(DATA_DIR, "backup", "snap");
    createVerifiedBackup(source, backupPath);
    rmSync(manifestPathFor(backupPath));
    expect(() => restoreBackupIntoEmptyProfile(backupPath, join(EMPTY_PROFILE(), "velarixbot.db"))).toThrow(
      /missing backup manifest/,
    );
  });

  it("refuses to overwrite an existing backup file", () => {
    const backupPath = join(DATA_DIR, "backup", "snap");
    createVerifiedBackup(source, backupPath);
    expect(() => createVerifiedBackup(source, backupPath)).toThrow(/already exists/);
  });

  it("v1 db-only archives restore the database but are not a complete backup", () => {
    const v2 = join(DATA_DIR, "backup", "snap");
    createVerifiedBackup(source, v2);
    const v1Db = join(DATA_DIR, "backup", "legacy.db");
    copyFileSync(archiveDb(v2), v1Db);
    const v1Manifest = {
      format: "velarixbot-backup" as const,
      version: 1,
      createdAt: 1,
      dbFile: "legacy.db",
      sha256: createHash("sha256").update(readFileSync(v1Db)).digest("hex"),
      sizeBytes: readFileSync(v1Db).length,
      schemaVersion: 3,
      integrity: "ok" as const,
      tables: tableCounts(source),
    };
    writeFileSync(`${v1Db}.manifest.json`, JSON.stringify(v1Manifest));
    expect(isBackupComplete(v1Manifest)).toBe(false);
    const outcome = restoreBackupIntoEmptyProfile(v1Db, join(EMPTY_PROFILE(), "velarixbot.db"));
    expect(outcome.complete).toBe(false);
    expect(outcome.tables.messages).toBe(2);
  });
});

describe("backup honesty: file-authoritative domains survive restore + refreshSnapshots", () => {
  let db: SqliteDatabase;
  beforeEach(async () => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    db = openDatabase(join(DATA_DIR, "velarixbot.db"));
    populate(createRepositories(db));
    addRule("bot-honesty", { tool: "Bash", pattern: "ls -la honesty", action: "allow" });
    saveSkill({ id: "skill-honesty", name: "Honesty skill", botId: "bot-honesty", markdown: SKILL_MARKDOWN });
    writeWorkspace(MEMORY_CANARY);
    await saveConfig({ xai: { key: SECRET_CANARY } });
  });
  afterEach(() => {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  });

  it("archives approvals, skills, memory, config, and secrets — not just velarixbot.db", () => {
    const archive = join(DATA_DIR, "backup", "honesty");
    const manifest = createVerifiedBackup(db, archive);

    expect(existsSync(archiveDb(archive))).toBe(true);
    expect(existsSync(join(archive, "approvals", "bot-honesty.json"))).toBe(true);
    expect(existsSync(join(archive, "skills.json"))).toBe(true);
    expect(existsSync(join(archive, "memory", "workspace.md"))).toBe(true);
    expect(existsSync(join(archive, "config.json"))).toBe(true);
    expect(existsSync(join(archive, "secrets.json"))).toBe(true);
    expect(manifest.coverage?.approvals.files).toBeGreaterThanOrEqual(1);
    expect(manifest.coverage?.skills.files).toBe(1);
    expect(manifest.coverage?.memory.files).toBeGreaterThanOrEqual(1);
    expect(manifest.coverage?.config.files).toBe(1);
    expect(manifest.coverage?.secrets.files).toBe(1);
    expect(isBackupComplete(manifest)).toBe(true);

    const meta = JSON.stringify(manifest);
    expect(meta).not.toContain(SECRET_CANARY);
    expect(meta).not.toContain(MEMORY_CANARY);
    expect(meta).not.toContain(SKILL_MARKDOWN);
    expect(readFileSync(join(archive, "memory", "workspace.md"), "utf8")).toContain(MEMORY_CANARY);

    if (process.platform !== "win32") {
      expect(statSync(join(archive, "secrets.json")).mode & 0o777).toBe(0o600);
      expect(statSync(join(archive, "config.json")).mode & 0o777).toBe(0o600);
    }
  });

  it("restore onto a wiped HOME keeps approvals, skills, and memory after refreshSnapshots", () => {
    const archive = join(DATA_DIR, "backup", "honesty");
    createVerifiedBackup(db, archive);
    db.close();

    // wipe the profile except the archive — the fresh-machine shape
    for (const name of readdirSync(DATA_DIR)) {
      if (name === "backup") continue;
      rmSync(join(DATA_DIR, name), { recursive: true, force: true });
    }
    expect(existsSync(join(DATA_DIR, "velarixbot.db"))).toBe(false);
    expect(existsSync(join(DATA_DIR, "skills.json"))).toBe(false);
    expect(existsSync(join(DATA_DIR, "memory", "workspace.md"))).toBe(false);
    expect(existsSync(join(DATA_DIR, "approvals", "bot-honesty.json"))).toBe(false);

    const outcome = restoreBackupIntoEmptyProfile(archive, join(DATA_DIR, "velarixbot.db"));
    expect(outcome.complete).toBe(true);

    expect(loadRules("bot-honesty").some((r) => r.tool === "Bash")).toBe(true);
    expect(loadSkills().map((s) => s.id)).toEqual(["skill-honesty"]);
    expect(readWorkspace()).toContain(MEMORY_CANARY);
    expect(existsSync(join(DATA_DIR, "config.json"))).toBe(true);
    expect(existsSync(join(DATA_DIR, "secrets.json"))).toBe(true);
    if (process.platform !== "win32") {
      expect(statSync(join(DATA_DIR, "secrets.json")).mode & 0o777).toBe(0o600);
    }

    const restored = openDatabase(join(DATA_DIR, "velarixbot.db"));
    try {
      const repos = createRepositories(restored);
      refreshSnapshots(repos, 99);
      expect(repos.snapshots.listSkills().map((s) => s.id)).toEqual(["skill-honesty"]);
      expect(repos.snapshots.listApprovalRules().some((r) => r.scope === "bot-honesty")).toBe(true);
      expect(repos.snapshots.listMemory().some((m) => m.user.includes(MEMORY_CANARY))).toBe(true);
    } finally {
      restored.close();
    }
  });

  it("does not report a complete/verified backup when a covered domain is missing", () => {
    const archive = join(DATA_DIR, "backup", "honesty");
    const manifest = createVerifiedBackup(db, archive);
    expect(isBackupComplete(manifest)).toBe(true);

    rmSync(join(archive, "memory", "workspace.md"));
    const target = join(EMPTY_PROFILE(), "velarixbot.db");
    expect(() => restoreBackupIntoEmptyProfile(archive, target)).toThrow(/missing covered file|checksum/);
    expect(existsSync(target)).toBe(false);

    const incomplete: BackupManifest = {
      ...readBackupManifest(archive),
      coverage: {
        ...manifest.coverage!,
        memory: { included: false, files: 0 },
      },
      complete: false,
    };
    writeFileSync(manifestPathFor(archive), JSON.stringify(incomplete, null, 2));
    mkdirSync(join(archive, "memory"), { recursive: true });
    writeFileSync(join(archive, "memory", "workspace.md"), MEMORY_CANARY);
    expect(isBackupComplete(readBackupManifest(archive))).toBe(false);
    expect(() => restoreBackupIntoEmptyProfile(archive, target)).toThrow(/incomplete backup|covered domain/);
    expect(existsSync(target)).toBe(false);
  });
});
