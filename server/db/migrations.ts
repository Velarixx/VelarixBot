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
  {
    // MEM v1: structured rows (preference | fact | workflow) are additive
    // to markdown files. The unused-for-runtime v1 `memory(owner,
    // user_text, distilled_text)` table stays the export snapshot of
    // those files — we do not dual-write rows into it and do not treat
    // it as a third store. Runtime retrieval reads markdown files +
    // `memory_rows` through one composition function.
    version: 4,
    name: "memory-rows",
    up(db) {
      db.exec(`
        CREATE TABLE memory_rows(
          id TEXT PRIMARY KEY,
          bot_id TEXT NOT NULL,
          type TEXT NOT NULL,
          text TEXT NOT NULL,
          pinned INTEGER NOT NULL DEFAULT 0,
          use_count INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX memory_rows_bot ON memory_rows(bot_id, updated_at);
      `);
    },
  },
  {
    // A⇄B DMs for ask_bot / delegate_bot visibility. dm=1 is the only
    // group kind this port creates — not rooms, bulletin, or voice.
    version: 5,
    name: "groups-dm",
    up(db) {
      db.exec(`
        CREATE TABLE groups(
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE,
          thread_id TEXT NOT NULL UNIQUE,
          created_at INTEGER NOT NULL,
          data TEXT NOT NULL
        );
        CREATE INDEX groups_thread ON groups(thread_id);
      `);
    },
  },
  {
    // Identity boundary for a later SaaS HTTP surface. Provider metadata is
    // deliberately separate from the durable internal UUID. Product data is
    // not user-scoped yet, so no SaaS route may rely on these tables until
    // user_id is propagated through every repository/workspace lookup.
    version: 6,
    name: "github-users-and-sessions",
    up(db) {
      db.exec(`
        CREATE TABLE users(
          id TEXT PRIMARY KEY NOT NULL,
          github_id INTEGER NOT NULL UNIQUE
            CHECK(typeof(github_id) = 'integer' AND github_id > 0),
          github_login TEXT NOT NULL,
          github_name TEXT,
          github_avatar_url TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TRIGGER users_github_id_immutable
          BEFORE UPDATE OF github_id ON users
          WHEN NEW.github_id <> OLD.github_id
          BEGIN
            SELECT RAISE(ABORT, 'github_id is immutable');
          END;
        CREATE TABLE sessions(
          token_digest TEXT PRIMARY KEY NOT NULL
            CHECK(length(token_digest) = 64 AND token_digest NOT GLOB '*[^0-9a-f]*'),
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL CHECK(expires_at > created_at),
          revoked_at INTEGER CHECK(revoked_at IS NULL OR revoked_at >= created_at)
        );
        CREATE INDEX sessions_expiry ON sessions(expires_at);
        CREATE INDEX sessions_user ON sessions(user_id);
      `);
    },
  },
  {
    // First tenant-owned product-data seam. Existing desktop bots stay
    // deliberately unowned: later account-claim behavior requires an
    // explicit product decision and must not silently attach local data to a
    // real user. SaaS callers must use owner-scoped repository methods.
    version: 7,
    name: "bot-user-ownership",
    up(db) {
      db.exec(`
        ALTER TABLE bots ADD COLUMN owner_id TEXT
          REFERENCES users(id) ON DELETE RESTRICT;
        CREATE INDEX bots_owner_seq ON bots(owner_id, seq DESC);
        CREATE INDEX bots_owner_thread ON bots(owner_id, thread_id);
      `);
    },
  },
  {
    // Thread ownership is deliberately nullable. Only threads already tied
    // to an owned bot are safe to backfill; desktop, group, and orphan
    // threads remain unowned until their own explicit product-data slice.
    version: 8,
    name: "thread-user-ownership",
    up(db) {
      db.exec(`
        ALTER TABLE threads ADD COLUMN owner_id TEXT
          REFERENCES users(id) ON DELETE RESTRICT;
        UPDATE threads
        SET owner_id = (
          SELECT bots.owner_id
          FROM bots
          WHERE bots.thread_id = threads.id
            AND bots.owner_id IS NOT NULL
        )
        WHERE EXISTS (
          SELECT 1
          FROM bots
          WHERE bots.thread_id = threads.id
            AND bots.owner_id IS NOT NULL
        );
        CREATE INDEX threads_owner_id ON threads(owner_id, id);
      `);
    },
  },
  {
    // Groups need the same explicit ownership seam as bots before their
    // threads can be exposed to tenant-scoped message APIs. Legacy desktop
    // groups stay unowned; account claiming is a separate product decision.
    version: 9,
    name: "group-user-ownership",
    up(db) {
      db.exec(`
        ALTER TABLE groups ADD COLUMN owner_id TEXT
          REFERENCES users(id) ON DELETE RESTRICT;
        CREATE INDEX groups_owner_seq ON groups(owner_id, seq DESC);
        CREATE INDEX groups_owner_thread ON groups(owner_id, thread_id);
      `);
    },
  },
  {
    // SaaS computer/workspace ownership is intentionally separate from the
    // legacy bot-keyed desktop cache. There is no safe account-claim rule for
    // existing computer_bindings rows, so this migration creates an empty
    // user-keyed seam and leaves every legacy row untouched.
    version: 10,
    name: "user-workspace-bindings",
    up(db) {
      db.exec(`
        CREATE TABLE user_workspace_bindings(
          user_id TEXT PRIMARY KEY NOT NULL
            REFERENCES users(id) ON DELETE RESTRICT,
          provider_kind TEXT NOT NULL
            CHECK(typeof(provider_kind) = 'text' AND length(provider_kind) > 0),
          machine_id TEXT NOT NULL
            CHECK(typeof(machine_id) = 'text' AND length(machine_id) > 0),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(provider_kind, machine_id)
        );
      `);
    },
  },
  {
    // Short-lived OAuth handshakes are server-owned and one-time. Only
    // digests of the browser-visible state and transaction cookie are
    // persisted; the PKCE verifier remains server-side until atomic consume.
    version: 11,
    name: "github-oauth-transactions",
    up(db) {
      db.exec(`
        CREATE TABLE github_oauth_transactions(
          state_digest TEXT PRIMARY KEY NOT NULL
            CHECK(length(state_digest) = 64 AND state_digest NOT GLOB '*[^0-9a-f]*'),
          cookie_digest TEXT NOT NULL
            CHECK(length(cookie_digest) = 64 AND cookie_digest NOT GLOB '*[^0-9a-f]*'),
          code_verifier TEXT NOT NULL
            CHECK(length(code_verifier) BETWEEN 43 AND 128),
          issued_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL CHECK(expires_at > issued_at),
          consumed_at INTEGER CHECK(consumed_at IS NULL OR consumed_at >= issued_at)
        );
        CREATE INDEX github_oauth_transactions_expiry
          ON github_oauth_transactions(expires_at);
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
