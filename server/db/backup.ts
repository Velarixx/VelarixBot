// Verified profile archive: SQLite snapshot PLUS the file-authoritative
// domains (approvals, skills, memory markdown) and an explicit
// config.json / secrets.json story. Those files are the runtime source;
// refreshSnapshots() rewrites the SQLite snapshot tables from disk on
// every boot, so a db-only restore onto a fresh machine silently drops
// rules, skills, and memory under a green checkmark.
//
// Backup is a directory:
//   velarixbot-<stamp>/
//     manifest.json
//     velarixbot.db          VACUUM INTO + integrity_check + row counts
//     approvals/*.json       live rules (not .bak)
//     approvals/audit.jsonl
//     skills.json
//     memory/*.md
//     config.json            included when present (secret-bearing)
//     secrets.json           included when present (secret-bearing)
//
// "Verified" / complete is not a hope: the db snapshot must pass
// integrity_check and match source row counts, every covered file is
// hashed into the manifest (paths + sha256 + size — never contents),
// and restore re-checks those hashes before and after copy. A covered
// domain that is empty at backup time is still recorded as included
// (files: 0). A v2 archive that omits a covered domain is incomplete
// and must not be reported as verified.
//
// Restore targets an EMPTY profile only. It refuses to overwrite an
// existing database or an existing covered file, and any post-copy
// failure removes the partial target — all-or-nothing.
//
// Secrets never appear in the manifest, API metadata, or logs. Archive
// copies of secret-bearing files are 0600 (best-effort on win32, same
// as database.ts / atomic.ts).
//
// Windows-safe: path.join everywhere; archive relative paths are POSIX
// (`approvals/bot.json`) so a backup restores across OS. chmod is
// best-effort. No POSIX-only lock assumptions.
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

import { atomicWriteFileSync, ensurePrivateDir, PRIVATE_FILE_MODE } from "../atomic.ts";
import { DATA_DIR } from "../config.ts";
import { DB_FILE_NAME, openDatabase } from "./database.ts";
import { EXPORT_TABLES } from "./export.ts";
import { loadBetterSqlite3, type SqliteDatabase } from "./sqlite-native.ts";

export const BACKUP_FORMAT = "velarixbot-backup";
export const BACKUP_VERSION = 2;
export const BACKUP_VERSION_V1 = 1;

export const COVERED_DOMAINS = ["database", "approvals", "skills", "memory", "config", "secrets"] as const;
export type CoveredDomain = (typeof COVERED_DOMAINS)[number];

export const SECRET_BEARING_RELS = new Set(["config.json", "secrets.json"]);

export interface BackupFileEntry {
  sha256: string;
  sizeBytes: number;
  secretBearing: boolean;
}

export interface DomainCoverage {
  included: boolean;
  files: number;
}

export type BackupCoverage = Record<CoveredDomain, DomainCoverage>;

export interface BackupManifest {
  format: typeof BACKUP_FORMAT;
  version: number;
  createdAt: number;
  dbFile: string;
  sha256: string;
  sizeBytes: number;
  schemaVersion: number;
  integrity: "ok";
  tables: Record<string, number>;
  /** Relative POSIX paths → checksums. Never file contents. */
  files?: Record<string, BackupFileEntry>;
  coverage?: BackupCoverage;
  complete?: boolean;
}

export function manifestPathFor(backupPath: string): string {
  try {
    if (statSync(backupPath).isDirectory()) return join(backupPath, "manifest.json");
  } catch {
    /* dest may not exist yet — infer from the path shape */
  }
  if (backupPath.endsWith(".db")) return `${backupPath}.manifest.json`;
  return join(backupPath, "manifest.json");
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

function listNames(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** Archive-relative POSIX path. Never path.join — win32 backslashes are not portable. */
export function posixRel(...parts: string[]): string {
  return parts.join("/");
}

function absFromRel(root: string, rel: string): string {
  return join(root, ...rel.split("/"));
}

export function profileDirOf(db: SqliteDatabase): string {
  const rows = db.pragma("database_list") as Array<{ name: string; file: string }>;
  const main = rows.find((r) => r.name === "main") ?? rows[0];
  if (main?.file) return dirname(main.file);
  return DATA_DIR;
}

export interface CoveredFile {
  rel: string;
  domain: Exclude<CoveredDomain, "database">;
  secretBearing: boolean;
}

/** Live file-authoritative + explicit config/secrets paths under `profileDir`. */
export function listCoveredFiles(profileDir: string): CoveredFile[] {
  const out: CoveredFile[] = [];
  for (const name of listNames(join(profileDir, "approvals"))) {
    if (name.endsWith(".bak")) continue;
    if (name === "audit.jsonl" || name.endsWith(".json")) {
      out.push({ rel: posixRel("approvals", name), domain: "approvals", secretBearing: false });
    }
  }
  if (existsSync(join(profileDir, "skills.json"))) {
    out.push({ rel: "skills.json", domain: "skills", secretBearing: false });
  }
  for (const name of listNames(join(profileDir, "memory"))) {
    if (name.endsWith(".md")) {
      out.push({ rel: posixRel("memory", name), domain: "memory", secretBearing: false });
    }
  }
  if (existsSync(join(profileDir, "config.json"))) {
    out.push({ rel: "config.json", domain: "config", secretBearing: SECRET_BEARING_RELS.has("config.json") });
  }
  if (existsSync(join(profileDir, "secrets.json"))) {
    out.push({ rel: "secrets.json", domain: "secrets", secretBearing: SECRET_BEARING_RELS.has("secrets.json") });
  }
  return out;
}

function emptyCoverage(): BackupCoverage {
  return {
    database: { included: true, files: 1 },
    approvals: { included: true, files: 0 },
    skills: { included: true, files: 0 },
    memory: { included: true, files: 0 },
    config: { included: true, files: 0 },
    secrets: { included: true, files: 0 },
  };
}

export function coverageFromFiles(files: Record<string, BackupFileEntry>): BackupCoverage {
  const coverage = emptyCoverage();
  for (const rel of Object.keys(files)) {
    if (rel === "config.json") coverage.config.files += 1;
    else if (rel === "secrets.json") coverage.secrets.files += 1;
    else if (rel === "skills.json") coverage.skills.files += 1;
    else if (rel.startsWith("memory/")) coverage.memory.files += 1;
    else if (rel.startsWith("approvals/")) coverage.approvals.files += 1;
  }
  return coverage;
}

export function isBackupComplete(manifest: BackupManifest): boolean {
  if (manifest.format !== BACKUP_FORMAT) return false;
  if (manifest.version < BACKUP_VERSION) return false;
  if (manifest.integrity !== "ok") return false;
  if (!manifest.coverage) return false;
  for (const domain of COVERED_DOMAINS) {
    if (manifest.coverage[domain]?.included !== true) return false;
  }
  return true;
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

function copyCoveredFile(source: string, dest: string, secretBearing: boolean): BackupFileEntry {
  const bytes = readFileSync(source);
  ensurePrivateDir(dirname(dest));
  atomicWriteFileSync(dest, bytes);
  if (secretBearing) bestEffortChmod(dest);
  const { sha256, sizeBytes } = sha256Of(dest);
  return { sha256, sizeBytes, secretBearing };
}

function verifyArchivedFiles(archiveDir: string, files: Record<string, BackupFileEntry>): void {
  for (const [rel, expected] of Object.entries(files)) {
    const path = absFromRel(archiveDir, rel);
    if (!existsSync(path)) throw new Error(`backup missing covered file: ${rel}`);
    const { sha256, sizeBytes } = sha256Of(path);
    if (sha256 !== expected.sha256) {
      throw new Error(`backup file checksum mismatch: ${rel}`);
    }
    if (sizeBytes !== expected.sizeBytes) {
      throw new Error(`backup file size mismatch: ${rel}`);
    }
  }
}

/** Snapshot the live profile into `destDir` and PROVE the copy is good
 * before returning. `destDir` is the archive directory (not the .db).
 * Throws on any failure and leaves no unverified archive behind. */
export function createVerifiedBackup(db: SqliteDatabase, destDir: string): BackupManifest {
  if (existsSync(destDir)) throw new Error(`backup destination already exists: ${destDir}`);
  ensurePrivateDir(dirname(destDir));
  ensurePrivateDir(destDir);
  const profileDir = profileDirOf(db);
  const sourceCounts = tableCounts(db);
  const schemaVersion = schemaVersionOf(db);
  const dbPath = join(destDir, DB_FILE_NAME);
  db.prepare("VACUUM INTO ?").run(dbPath);
  bestEffortChmod(dbPath);
  try {
    const verified = inspectSnapshot(dbPath, (snapshot) => {
      const integrity = snapshot.pragma("integrity_check", { simple: true });
      if (integrity !== "ok") throw new Error(`snapshot failed integrity_check: ${String(integrity)}`);
      const mismatch = countsMismatch(sourceCounts, tableCounts(snapshot));
      if (mismatch) throw new Error(`snapshot row counts diverge from source — ${mismatch}`);
      return { counts: tableCounts(snapshot) };
    });
    const { sha256, sizeBytes } = sha256Of(dbPath);
    const files: Record<string, BackupFileEntry> = {};
    for (const { rel, secretBearing } of listCoveredFiles(profileDir)) {
      files[rel] = copyCoveredFile(absFromRel(profileDir, rel), absFromRel(destDir, rel), secretBearing);
    }
    const coverage = coverageFromFiles(files);
    const manifest: BackupManifest = {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      createdAt: Date.now(),
      dbFile: DB_FILE_NAME,
      sha256,
      sizeBytes,
      schemaVersion,
      integrity: "ok",
      tables: verified.counts,
      files,
      coverage,
      complete: true,
    };
    if (!isBackupComplete(manifest)) {
      throw new Error("backup omitted a covered domain — refusing to call this verified");
    }
    atomicWriteFileSync(manifestPathFor(destDir), JSON.stringify(manifest, null, 2));
    return manifest;
  } catch (e) {
    rmSync(destDir, { recursive: true, force: true });
    throw e;
  }
}

export function readBackupManifest(backupPath: string): BackupManifest {
  const manifestFile = manifestPathFor(backupPath);
  let raw: string;
  try {
    raw = readFileSync(manifestFile, "utf8");
  } catch {
    throw new Error(`missing backup manifest: ${manifestFile}`);
  }
  const manifest = JSON.parse(raw) as BackupManifest;
  if (manifest.format !== BACKUP_FORMAT) throw new Error("not a velarixbot backup manifest");
  if (manifest.version !== BACKUP_VERSION && manifest.version !== BACKUP_VERSION_V1) {
    throw new Error(`unsupported backup version ${manifest.version}`);
  }
  if (typeof manifest.sha256 !== "string" || !manifest.sha256) throw new Error("backup manifest has no sha256");
  return manifest;
}

export interface RestoreOutcome {
  tables: Record<string, number>;
  schemaVersion: number;
  sha256: string;
  complete: boolean;
  coverage?: BackupCoverage;
}

function isArchiveDir(backupPath: string): boolean {
  try {
    return statSync(backupPath).isDirectory();
  } catch {
    return false;
  }
}

function dbFileInArchive(backupPath: string, manifest: BackupManifest): string {
  if (isArchiveDir(backupPath)) return join(backupPath, manifest.dbFile || DB_FILE_NAME);
  return backupPath;
}

function removeRestored(targetDbPath: string, copiedRels: string[]): void {
  const profileDir = dirname(targetDbPath);
  for (const file of [targetDbPath, `${targetDbPath}-wal`, `${targetDbPath}-shm`]) rmSync(file, { force: true });
  for (const rel of copiedRels) rmSync(absFromRel(profileDir, rel), { force: true });
}

/** Restore a verified backup into an EMPTY profile: `targetDbPath` (and its
 * -wal/-shm siblings) must not exist, and neither may any covered file the
 * archive is about to write. The archive's SHA-256 must match its manifest
 * and the snapshot must pass integrity_check BEFORE anything is copied;
 * v2 archives must be complete (every covered domain included) and every
 * listed file must match its checksum. After the copy the reopened
 * database and restored files must reproduce the manifest, or the partial
 * target is removed and the restore throws. */
export function restoreBackupIntoEmptyProfile(backupPath: string, targetDbPath: string): RestoreOutcome {
  const manifest = readBackupManifest(backupPath);
  const archiveDb = dbFileInArchive(backupPath, manifest);
  if (!existsSync(archiveDb)) throw new Error(`missing backup file: ${archiveDb}`);
  const profileDir = dirname(targetDbPath);
  for (const file of [targetDbPath, `${targetDbPath}-wal`, `${targetDbPath}-shm`]) {
    if (existsSync(file)) {
      throw new Error(`restore requires an empty profile — ${file} already exists (move it aside first)`);
    }
  }
  const listedFiles = manifest.files ?? {};
  for (const rel of Object.keys(listedFiles)) {
    const dest = absFromRel(profileDir, rel);
    if (existsSync(dest)) {
      throw new Error(`restore requires an empty profile — ${dest} already exists (move it aside first)`);
    }
  }

  if (manifest.version >= BACKUP_VERSION && !isBackupComplete(manifest)) {
    throw new Error("incomplete backup — a covered domain is missing; refusing a verified restore");
  }
  if (isArchiveDir(backupPath) && manifest.files) {
    verifyArchivedFiles(backupPath, manifest.files);
  }

  const { sha256 } = sha256Of(archiveDb);
  if (sha256 !== manifest.sha256) {
    throw new Error(`backup checksum mismatch: manifest says ${manifest.sha256}, file is ${sha256}`);
  }
  inspectSnapshot(archiveDb, (snapshot) => {
    const integrity = snapshot.pragma("integrity_check", { simple: true });
    if (integrity !== "ok") throw new Error(`backup failed integrity_check: ${String(integrity)}`);
  });

  ensurePrivateDir(profileDir);
  const copiedRels: string[] = [];
  copyFileSync(archiveDb, targetDbPath);
  bestEffortChmod(targetDbPath);
  try {
    if (isArchiveDir(backupPath)) {
      for (const [rel, meta] of Object.entries(listedFiles)) {
        copyCoveredFile(absFromRel(backupPath, rel), absFromRel(profileDir, rel), meta.secretBearing);
        copiedRels.push(rel);
      }
      verifyArchivedFiles(profileDir, listedFiles);
    }
    // openDatabase re-applies the WAL pragmas and runs any migrations this
    // build knows that the snapshot predates — a backup restores cleanly
    // into the same or a newer build of the app.
    const db = openDatabase(targetDbPath);
    try {
      const counts = tableCounts(db);
      const mismatch = countsMismatch(manifest.tables, counts);
      if (mismatch) throw new Error(`restored row counts diverge from manifest — ${mismatch}`);
      return {
        tables: counts,
        schemaVersion: schemaVersionOf(db),
        sha256,
        complete: isBackupComplete(manifest),
        coverage: manifest.coverage,
      };
    } finally {
      db.close();
    }
  } catch (e) {
    removeRestored(targetDbPath, copiedRels);
    throw e;
  }
}
