// P1.7 acceptance: verified SQLite snapshot backup + restore-into-empty-
// profile as a CI test, not a hope. Source profile and target profile are
// two separate directories under the throwaway test home (Windows-safe:
// tmpdir + join via testing/setup.ts, no POSIX path or lock assumptions).
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "../config.ts";
import { createRepositories, type Repositories } from "../repositories/index.ts";
import { createVerifiedBackup, manifestPathFor, restoreBackupIntoEmptyProfile, tableCounts } from "./backup.ts";
import { openDatabase } from "./database.ts";
import { EXPORT_TABLES } from "./export.ts";
import type { SqliteDatabase } from "./sqlite-native.ts";

const SOURCE_PROFILE = () => join(DATA_DIR, "profile-source");
const EMPTY_PROFILE = () => join(DATA_DIR, "profile-empty");

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
    const backupPath = join(DATA_DIR, "backup", "snap.db");
    const manifest = createVerifiedBackup(source, backupPath);

    expect(manifest.integrity).toBe("ok");
    expect(manifest.tables).toEqual(tableCounts(source));
    expect(manifest.tables.messages).toBe(2);
    expect(manifest.schemaVersion).toBeGreaterThanOrEqual(3);
    // the manifest sha256 is the sha of the exact bytes on disk
    const actual = createHash("sha256").update(readFileSync(backupPath)).digest("hex");
    expect(manifest.sha256).toBe(actual);
    expect(JSON.parse(readFileSync(manifestPathFor(backupPath), "utf8"))).toEqual(manifest);
  });

  it("captures rows still sitting in the WAL (no checkpoint needed before backup)", () => {
    // populate() above committed through WAL and nothing has checkpointed;
    // the snapshot must still contain every acknowledged row
    expect(existsSync(join(SOURCE_PROFILE(), "velarixbot.db-wal"))).toBe(true);
    const backupPath = join(DATA_DIR, "backup", "wal-snap.db");
    const manifest = createVerifiedBackup(source, backupPath);
    expect(manifest.tables.messages).toBe(2);
    expect(manifest.tables.bots).toBe(1);
  });

  it("restores into an empty profile and reproduces every table", () => {
    const backupPath = join(DATA_DIR, "backup", "snap.db");
    createVerifiedBackup(source, backupPath);

    const targetDbPath = join(EMPTY_PROFILE(), "velarixbot.db");
    const outcome = restoreBackupIntoEmptyProfile(backupPath, targetDbPath);
    expect(outcome.tables).toEqual(tableCounts(source));

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
    const backupPath = join(DATA_DIR, "backup", "snap.db");
    createVerifiedBackup(source, backupPath);

    const occupied = join(EMPTY_PROFILE(), "velarixbot.db");
    const existing = openDatabase(occupied);
    existing.close();
    expect(() => restoreBackupIntoEmptyProfile(backupPath, occupied)).toThrow(/empty profile/);
  });

  it("rejects a tampered archive before touching the target profile", () => {
    const backupPath = join(DATA_DIR, "backup", "snap.db");
    createVerifiedBackup(source, backupPath);
    // flip bytes in the middle of the file — sha256 no longer matches
    const bytes = readFileSync(backupPath);
    bytes[Math.floor(bytes.length / 2)] ^= 0xff;
    writeFileSync(backupPath, bytes);

    const targetDbPath = join(EMPTY_PROFILE(), "velarixbot.db");
    expect(() => restoreBackupIntoEmptyProfile(backupPath, targetDbPath)).toThrow(/checksum mismatch/);
    expect(existsSync(targetDbPath)).toBe(false);
  });

  it("rejects a restore without its manifest (unverifiable archive)", () => {
    const backupPath = join(DATA_DIR, "backup", "snap.db");
    createVerifiedBackup(source, backupPath);
    rmSync(manifestPathFor(backupPath));
    expect(() => restoreBackupIntoEmptyProfile(backupPath, join(EMPTY_PROFILE(), "velarixbot.db"))).toThrow(/missing backup manifest/);
  });

  it("refuses to overwrite an existing backup file", () => {
    const backupPath = join(DATA_DIR, "backup", "snap.db");
    createVerifiedBackup(source, backupPath);
    expect(() => createVerifiedBackup(source, backupPath)).toThrow(/already exists/);
  });
});
