// Schema migrations. Append-only: never edit a shipped migration, add a new
// one. The runner records completions by NAME in schema_migrations, so the
// suite is idempotent — re-running applies nothing and rewrites nothing.
// Data migrations (the legacy-JSON import) record themselves in the same
// table under version 0 so a rerun is a no-op without needing extra tables.
import type { SqliteDatabase } from "./sqlite-native.ts";

export interface Migration {
  version: number;
  name: string;
  up(db: SqliteDatabase): void;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "initial-schema",
    up(db) {
      db.exec(`
        CREATE TABLE threads(
          id TEXT PRIMARY KEY,
          bot_id TEXT,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE bots(
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE,
          thread_id TEXT NOT NULL UNIQUE REFERENCES threads(id),
          created_at INTEGER NOT NULL,
          data TEXT NOT NULL
        );
        CREATE TABLE messages(
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE,
          thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
          at INTEGER NOT NULL,
          png_hash TEXT,
          data TEXT NOT NULL
        );
        CREATE INDEX messages_thread_seq ON messages(thread_id, seq);
        CREATE INDEX messages_png_hash ON messages(png_hash) WHERE png_hash IS NOT NULL;
        CREATE TABLE event_log(
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          event_id TEXT NOT NULL,
          thread_id TEXT NOT NULL,
          type TEXT NOT NULL,
          created_at TEXT NOT NULL,
          data TEXT NOT NULL
        );
        CREATE INDEX event_log_thread ON event_log(thread_id, seq);
        CREATE TABLE routines(
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE,
          bot_id TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          data TEXT NOT NULL
        );
        CREATE TABLE routine_runs(
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          routine_id TEXT NOT NULL,
          bot_id TEXT NOT NULL,
          started_at INTEGER NOT NULL,
          finished_at INTEGER,
          result TEXT
        );
        CREATE INDEX routine_runs_routine ON routine_runs(routine_id, seq);
        CREATE TABLE approval_rules(
          scope TEXT NOT NULL,
          id TEXT NOT NULL,
          tool TEXT NOT NULL,
          pattern TEXT NOT NULL,
          action TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          disabled INTEGER NOT NULL DEFAULT 0,
          quarantined INTEGER NOT NULL DEFAULT 0,
          confirmed INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (scope, id)
        );
        CREATE TABLE approval_audit(
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          at INTEGER NOT NULL,
          bot TEXT NOT NULL,
          tool TEXT NOT NULL,
          matcher TEXT NOT NULL,
          decision TEXT NOT NULL,
          rule_id TEXT
        );
        CREATE TABLE skills(
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          bot_id TEXT NOT NULL,
          markdown TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE memory(
          owner TEXT PRIMARY KEY,
          user_text TEXT NOT NULL DEFAULT '',
          distilled_text TEXT NOT NULL DEFAULT '',
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE computer_bindings(
          bot_id TEXT PRIMARY KEY,
          box_id TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);
    },
  },
];

export interface MigrationRow {
  name: string;
  version: number;
  applied_at: number;
  checksum: string | null;
}

function ensureMigrationsTable(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations(
      name TEXT PRIMARY KEY,
      version INTEGER NOT NULL,
      applied_at INTEGER NOT NULL,
      checksum TEXT
    );
  `);
}

export function appliedMigrations(db: SqliteDatabase): MigrationRow[] {
  ensureMigrationsTable(db);
  return db.prepare<MigrationRow>("SELECT name, version, applied_at, checksum FROM schema_migrations ORDER BY version, name").all();
}

export function isApplied(db: SqliteDatabase, name: string): boolean {
  ensureMigrationsTable(db);
  return db.prepare("SELECT 1 FROM schema_migrations WHERE name = ?").get(name) !== undefined;
}

export function recordApplied(db: SqliteDatabase, entry: { name: string; version: number; checksum?: string | null; now?: number }): void {
  ensureMigrationsTable(db);
  db.prepare("INSERT INTO schema_migrations(name, version, applied_at, checksum) VALUES (?, ?, ?, ?)").run(
    entry.name,
    entry.version,
    entry.now ?? Date.now(),
    entry.checksum ?? null,
  );
}

/** Apply every pending migration, each in its own transaction with its
 * completion record — a crash mid-migration rolls the step back whole.
 * Returns the names applied this call (empty on a rerun: idempotent). */
export function migrate(db: SqliteDatabase, migrations: Migration[] = MIGRATIONS): string[] {
  ensureMigrationsTable(db);
  const applied: string[] = [];
  for (const migration of [...migrations].sort((a, b) => a.version - b.version)) {
    if (isApplied(db, migration.name)) continue;
    db.transaction(() => {
      migration.up(db);
      recordApplied(db, { name: migration.name, version: migration.version });
    })();
    applied.push(migration.name);
  }
  return applied;
}
