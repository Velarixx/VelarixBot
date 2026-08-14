// P1.7 verified SQLite snapshot backup + restore-into-empty-profile.
//
// Backup is `VACUUM INTO` — SQLite writes a compact, transaction-consistent
// copy of the live database (WAL content included) without blocking writers.
// "Verified" is not a hope: the snapshot is reopened and must pass
// PRAGMA integrity_check, its per-table row counts must equal the source's,
// and a sidecar manifest records the SHA-256 of the exact bytes so restore
// can prove the file it was handed is the file backup wrote.
//
// Restore targets an EMPTY profile only (the acceptance shape: a fresh
// machine / fresh data dir). It refuses to overwrite an existing database,
// re-verifies checksum + integrity BEFORE copying, and re-counts every
// domain table after opening the restored copy. Any post-copy failure
// removes the partial target — all-or-nothing.
//
// Windows-safe: path.join everywhere, no POSIX-only lock or mode assumptions
// (chmod is best-effort exactly like database.ts).
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname } from "node:path";

import { atomicWriteFileSync, ensurePrivateDir, PRIVATE_FILE_MODE } from "../atomic.ts";
import { EXPORT_TABLES } from "./export.ts";
import { openDatabase } from "./database.ts";
import { loadBetterSqlite3, type SqliteDatabase } from "./sqlite-native.ts";

export const BACKUP_FORMAT = "velarixbot-backup";
export const BACKUP_VERSION = 1;

export interface BackupManifest {
  format: typeof BACKUP_FORMAT;
  version: typeof BACKUP_VERSION;
  createdAt: number;
  dbFile: string;
  sha256: string;
  sizeBytes: number;
  schemaVersion: number;
  integrity: "ok";
  tables: Record<string, number>;
}

export function manifestPathFor(backupPath: string): string {
  return `${backupPath}.manifest.json`;
}

function sha256Of(path: string): { sha256: string; sizeBytes: number } {
  const bytes = readFileSync(path);
  return { sha256: createHash("sha256").update(bytes).digest("hex"), sizeBytes: bytes.length };
}

export function tableCounts(db: SqliteDatabase): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const { table } of EXPORT_TABLES) {
    counts[table] = (db.prepare<{ n: number }>(`SELECT count(*) AS n FROM ${table}`).get()?.n as number) ?? 0;
  }
  return counts;
}

function schemaVersionOf(db: SqliteDatabase): number {
  return (db.prepare<{ v: number }>("SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations").get()?.v as number) ?? 0;
}

function bestEffortChmod(path: string): void {
  try {
    chmodSync(path, PRIVATE_FILE_MODE);
  } catch {
    /* same no-op semantics as database.ts on exotic filesystems / win32 */
  }
}

/** Open a snapshot file WITHOUT migrating or switching journal modes —
 * verification must inspect the bytes backup wrote, not mutate them. */
function inspectSnapshot<T>(path: string, fn: (db: SqliteDatabase) => T): T {
  const Database = loadBetterSqlite3();
  const db = new Database(path);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function countsMismatch(expected: Record<string, number>, actual: Record<string, number>): string | null {
  for (const { table } of EXPORT_TABLES) {
    if ((expected[table] ?? 0) !== (actual[table] ?? 0)) {
      return `table ${table}: expected ${expected[table] ?? 0} rows, found ${actual[table] ?? 0}`;
    }
  }
  return null;
}

/** Snapshot `db` to `destPath` and PROVE the copy is good before returning:
 * integrity_check must say ok and every domain table's row count must match
 * the source. Writes `<destPath>.manifest.json` (sha256 + counts) so a later
 * restore can verify the archive byte-for-byte. Throws on any failure and
 * leaves no unverified snapshot behind. */
export function createVerifiedBackup(db: SqliteDatabase, destPath: string): BackupManifest {
  if (existsSync(destPath)) throw new Error(`backup destination already exists: ${destPath}`);
  ensurePrivateDir(dirname(destPath));
  const sourceCounts = tableCounts(db);
  const schemaVersion = schemaVersionOf(db);
  db.prepare("VACUUM INTO ?").run(destPath);
  bestEffortChmod(destPath);
  try {
    const verified = inspectSnapshot(destPath, (snapshot) => {
      const integrity = snapshot.pragma("integrity_check", { simple: true });
      if (integrity !== "ok") throw new Error(`snapshot failed integrity_check: ${String(integrity)}`);
      const mismatch = countsMismatch(sourceCounts, tableCounts(snapshot));
      if (mismatch) throw new Error(`snapshot row counts diverge from source — ${mismatch}`);
      return { counts: tableCounts(snapshot) };
    });
    const { sha256, sizeBytes } = sha256Of(destPath);
    const manifest: BackupManifest = {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      createdAt: Date.now(),
      dbFile: basename(destPath),
      sha256,
      sizeBytes,
      schemaVersion,
      integrity: "ok",
      tables: verified.counts,
    };
    atomicWriteFileSync(manifestPathFor(destPath), JSON.stringify(manifest, null, 2));
    return manifest;
  } catch (e) {
    rmSync(destPath, { force: true });
    rmSync(manifestPathFor(destPath), { force: true });
    throw e;
  }
}

export function readBackupManifest(backupPath: string): BackupManifest {
  let raw: string;
  try {
    raw = readFileSync(manifestPathFor(backupPath), "utf8");
  } catch {
    throw new Error(`missing backup manifest: ${manifestPathFor(backupPath)}`);
  }
  const manifest = JSON.parse(raw) as BackupManifest;
  if (manifest.format !== BACKUP_FORMAT) throw new Error("not a velarixbot backup manifest");
  if (manifest.version !== BACKUP_VERSION) throw new Error(`unsupported backup version ${manifest.version}`);
  if (typeof manifest.sha256 !== "string" || !manifest.sha256) throw new Error("backup manifest has no sha256");
  return manifest;
}

export interface RestoreOutcome {
  tables: Record<string, number>;
  schemaVersion: number;
  sha256: string;
}

/** Restore a verified backup into an EMPTY profile: `targetDbPath` (and its
 * -wal/-shm siblings) must not exist. The archive's SHA-256 must match its
 * manifest and the snapshot must pass integrity_check BEFORE anything is
 * copied; after the copy the reopened database must reproduce the manifest's
 * row counts, or the partial target is removed and the restore throws. */
export function restoreBackupIntoEmptyProfile(backupPath: string, targetDbPath: string): RestoreOutcome {
  const manifest = readBackupManifest(backupPath);
  if (!existsSync(backupPath)) throw new Error(`missing backup file: ${backupPath}`);
  for (const file of [targetDbPath, `${targetDbPath}-wal`, `${targetDbPath}-shm`]) {
    if (existsSync(file)) {
      throw new Error(`restore requires an empty profile — ${file} already exists (move it aside first)`);
    }
  }
  const { sha256 } = sha256Of(backupPath);
  if (sha256 !== manifest.sha256) {
    throw new Error(`backup checksum mismatch: manifest says ${manifest.sha256}, file is ${sha256}`);
  }
  inspectSnapshot(backupPath, (snapshot) => {
    const integrity = snapshot.pragma("integrity_check", { simple: true });
    if (integrity !== "ok") throw new Error(`backup failed integrity_check: ${String(integrity)}`);
  });

  ensurePrivateDir(dirname(targetDbPath));
  copyFileSync(backupPath, targetDbPath);
  bestEffortChmod(targetDbPath);
  try {
    // openDatabase re-applies the WAL pragmas and runs any migrations this
    // build knows that the snapshot predates — a backup restores cleanly
    // into the same or a newer build of the app.
    const db = openDatabase(targetDbPath);
    try {
      const counts = tableCounts(db);
      const mismatch = countsMismatch(manifest.tables, counts);
      if (mismatch) throw new Error(`restored row counts diverge from manifest — ${mismatch}`);
      return { tables: counts, schemaVersion: schemaVersionOf(db), sha256 };
    } finally {
      db.close();
    }
  } catch (e) {
    for (const file of [targetDbPath, `${targetDbPath}-wal`, `${targetDbPath}-shm`]) rmSync(file, { force: true });
    throw e;
  }
}
