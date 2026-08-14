// One SQLite file per install: ~/.velarixbot/velarixbot.db.
//
// Durability model (replaces the per-file JSON atomic-write pattern for the
// store domain): WAL journal + transactions. A committed transaction
// survives a process kill (the acceptance the crash-recovery harness pins);
// an append is one INSERT into the WAL — it never rewrites prior rows, so
// message #100,001 costs the same as message #1. synchronous=NORMAL is the
// documented WAL pairing: commits are crash-safe against process death and
// the database file can never be torn.
//
// Everything under ~/.velarixbot stays user-private: the db, -wal, and -shm
// files are tightened to 0600 (no-op semantics on win32, like atomic.ts).
import { chmodSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

import { ensurePrivateDir, PRIVATE_FILE_MODE } from "../atomic.ts";
import { DATA_DIR } from "../config.ts";
import { migrate } from "./migrations.ts";
import { loadBetterSqlite3, type SqliteDatabase } from "./sqlite-native.ts";

export const DB_FILE_NAME = "velarixbot.db";

export function defaultDbPath(): string {
  return join(DATA_DIR, DB_FILE_NAME);
}

function tightenDbFileModes(path: string): void {
  for (const file of [path, `${path}-wal`, `${path}-shm`]) {
    if (!existsSync(file)) continue;
    try {
      chmodSync(file, PRIVATE_FILE_MODE);
    } catch {
      /* best-effort on exotic filesystems; NTFS ACLs already scope the profile */
    }
  }
}

/** Open (creating if needed) a migrated database at `path`. */
export function openDatabase(path: string): SqliteDatabase {
  ensurePrivateDir(dirname(path));
  const Database = loadBetterSqlite3();
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  migrate(db);
  tightenDbFileModes(path);
  return db;
}

/** The application database under ~/.velarixbot. */
export function openDefaultDatabase(): SqliteDatabase {
  return openDatabase(defaultDbPath());
}
