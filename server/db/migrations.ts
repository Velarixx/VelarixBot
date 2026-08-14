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
  {
    version: 2,
    name: "routine-run-durability",
    up(db) {
      // P1.2: routine_runs becomes the durable run ledger — leases,
      // attempts, idempotency keys, and an explicit status. Legacy rows are
      // backfilled: a row a previous version left open can only be a run
      // that died with the process, so it closes as interrupted.
      db.exec(`
        ALTER TABLE routine_runs ADD COLUMN scheduled_for INTEGER;
        ALTER TABLE routine_runs ADD COLUMN kind TEXT NOT NULL DEFAULT 'scheduled';
        ALTER TABLE routine_runs ADD COLUMN status TEXT;
        ALTER TABLE routine_runs ADD COLUMN attempt INTEGER NOT NULL DEFAULT 1;
        ALTER TABLE routine_runs ADD COLUMN idempotency_key TEXT;
        ALTER TABLE routine_runs ADD COLUMN lease_until INTEGER;
        UPDATE routine_runs SET status = CASE
          WHEN finished_at IS NULL THEN 'interrupted'
          WHEN result = 'DONE' THEN 'done'
          ELSE 'blocked' END
        WHERE status IS NULL;
        UPDATE routine_runs SET
          result = COALESCE(result, 'interrupted: VelarixBot quit mid-run'),
          finished_at = started_at
        WHERE finished_at IS NULL;
        CREATE UNIQUE INDEX routine_runs_idempotency
          ON routine_runs(idempotency_key) WHERE idempotency_key IS NOT NULL;
      `);
    },
  },
  {
    // P1.3: per-stream sequences on the event log. Runtime events are
    // sequenced on their thread's stream; the SSE hub persists renderer
    // frames on its own "ui" stream. `sequence` is 1-based and gap-free
    // within a stream, so `id:`/Last-Event-ID resume can prove zero
    // loss/dupes. Existing rows are backfilled in global-seq order.
    version: 3,
    name: "event-log-stream-sequences",
    up(db) {
      db.exec(`
        ALTER TABLE event_log ADD COLUMN stream_id TEXT;
        ALTER TABLE event_log ADD COLUMN sequence INTEGER;
        ALTER TABLE event_log ADD COLUMN schema_version INTEGER;
      `);
      const rows = db.prepare<{ seq: number; thread_id: string }>("SELECT seq, thread_id FROM event_log ORDER BY seq").all();
      const update = db.prepare("UPDATE event_log SET stream_id = ?, sequence = ?, schema_version = 1 WHERE seq = ?");
      const counters = new Map<string, number>();
      for (const row of rows) {
        const next = (counters.get(row.thread_id) ?? 0) + 1;
        counters.set(row.thread_id, next);
        update.run(row.thread_id, next, row.seq);
      }
      db.exec("CREATE UNIQUE INDEX event_log_stream_sequence ON event_log(stream_id, sequence);");
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
