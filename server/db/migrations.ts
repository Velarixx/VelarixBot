// Schema migrations. Append-only: never edit a shipped migration, add a new
// one. The runner records completions by NAME in schema_migrations, so the
// suite is idempotent — re-running applies nothing and rewrites nothing.
// Data migrations (the legacy-JSON import) record themselves in the same
// table under version 0 so a rerun is a no-op without needing extra tables.
import {
  generatePublicBotHandle,
  PUBLIC_BOT_HANDLE_GENERATION_ATTEMPTS,
} from "../public-bot-handle.ts";
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
  {
    // Server-only authorization material for later browser desktop access.
    // The browser-visible secret is never stored: only its SHA-256 digest is
    // durable. Binding updated_at is captured as a revision so an old grant
    // cannot become valid again after a machine binding is changed and later
    // changed back to the same opaque identifiers.
    version: 12,
    name: "desktop-access-grants",
    up(db) {
      db.exec(`
        CREATE TABLE desktop_access_grants(
          token_digest TEXT PRIMARY KEY NOT NULL
            CHECK(length(token_digest) = 64 AND token_digest NOT GLOB '*[^0-9a-f]*'),
          owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE
            CHECK(
              length(owner_id) = 36
              AND substr(owner_id, 9, 1) = '-'
              AND substr(owner_id, 14, 1) = '-'
              AND substr(owner_id, 19, 1) = '-'
              AND substr(owner_id, 24, 1) = '-'
              AND lower(owner_id) NOT GLOB '*[^0-9a-f-]*'
            ),
          provider_kind TEXT NOT NULL
            CHECK(
              length(provider_kind) BETWEEN 1 AND 64
              AND provider_kind = lower(provider_kind)
              AND substr(provider_kind, 1, 1) GLOB '[a-z]'
              AND provider_kind NOT GLOB '*[^a-z0-9-]*'
            ),
          machine_id TEXT NOT NULL
            CHECK(
              length(machine_id) BETWEEN 1 AND 255
              AND substr(machine_id, 1, 1) GLOB '[A-Za-z0-9]'
              AND machine_id NOT GLOB '*[^A-Za-z0-9._:-]*'
            ),
          scope TEXT NOT NULL CHECK(scope IN ('desktop:view', 'desktop:control')),
          binding_updated_at INTEGER NOT NULL
            CHECK(typeof(binding_updated_at) = 'integer' AND binding_updated_at BETWEEN 0 AND 9007199254740991),
          created_at INTEGER NOT NULL
            CHECK(typeof(created_at) = 'integer' AND created_at BETWEEN 0 AND 9007199254740991),
          expires_at INTEGER NOT NULL
            CHECK(
              typeof(expires_at) = 'integer'
              AND expires_at > created_at
              AND expires_at <= created_at + 300000
              AND expires_at <= 9007199254740991
            ),
          revoked_at INTEGER
            CHECK(
              revoked_at IS NULL
              OR (
                typeof(revoked_at) = 'integer'
                AND revoked_at BETWEEN created_at AND 9007199254740991
              )
            )
        );
        CREATE INDEX desktop_access_grants_owner_expiry
          ON desktop_access_grants(owner_id, expires_at, token_digest);
      `);
    },
  },
  {
    // Authorization generations are independent of wall-clock time and
    // survive binding deletion. The per-user counter is retained as a
    // tombstone, so equal-timestamp A -> B -> A and delete -> recreate can
    // never make an older grant current again. Existing short-lived grants
    // are deliberately invalidated instead of guessing a safe generation.
    version: 13,
    name: "workspace-binding-authorization-generations",
    up(db) {
      db.exec(`
        CREATE TABLE user_workspace_binding_generations(
          user_id TEXT PRIMARY KEY NOT NULL
            REFERENCES users(id) ON DELETE CASCADE,
          generation INTEGER NOT NULL
            CHECK(typeof(generation) = 'integer' AND generation BETWEEN 1 AND 9007199254740991)
        );
        INSERT INTO user_workspace_binding_generations(user_id, generation)
        SELECT user_id, 1 FROM user_workspace_bindings;

        CREATE TABLE user_workspace_bindings_v13(
          user_id TEXT PRIMARY KEY NOT NULL
            REFERENCES users(id) ON DELETE RESTRICT,
          provider_kind TEXT NOT NULL
            CHECK(typeof(provider_kind) = 'text' AND length(provider_kind) > 0),
          machine_id TEXT NOT NULL
            CHECK(typeof(machine_id) = 'text' AND length(machine_id) > 0),
          authorization_generation INTEGER NOT NULL
            CHECK(typeof(authorization_generation) = 'integer' AND authorization_generation BETWEEN 1 AND 9007199254740991),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(provider_kind, machine_id)
        );
        INSERT INTO user_workspace_bindings_v13(
          user_id, provider_kind, machine_id, authorization_generation, created_at, updated_at
        )
        SELECT user_id, provider_kind, machine_id, 1, created_at, updated_at
        FROM user_workspace_bindings;
        DROP TABLE user_workspace_bindings;
        ALTER TABLE user_workspace_bindings_v13 RENAME TO user_workspace_bindings;
        CREATE TRIGGER user_workspace_binding_generation_monotonic
          BEFORE UPDATE OF generation ON user_workspace_binding_generations
          WHEN NEW.generation <= OLD.generation
          BEGIN
            SELECT RAISE(ABORT, 'workspace authorization generation must increase');
          END;
        CREATE TRIGGER user_workspace_binding_generation_retained
          BEFORE DELETE ON user_workspace_binding_generations
          WHEN EXISTS(SELECT 1 FROM users WHERE id = OLD.user_id)
          BEGIN
            SELECT RAISE(ABORT, 'workspace authorization generation is retained');
          END;
        CREATE TRIGGER user_workspace_binding_delete_advances_generation
          BEFORE DELETE ON user_workspace_bindings
          BEGIN
            UPDATE user_workspace_binding_generations
            SET generation = generation + 1
            WHERE user_id = OLD.user_id
              AND generation = OLD.authorization_generation
              AND generation < 9007199254740991;
            SELECT CASE WHEN changes() <> 1
              THEN RAISE(ABORT, 'workspace authorization generation could not advance')
            END;
          END;
        CREATE TRIGGER user_workspace_binding_generation_insert_current
          BEFORE INSERT ON user_workspace_bindings
          WHEN NOT EXISTS(
            SELECT 1 FROM user_workspace_binding_generations g
            WHERE g.user_id = NEW.user_id AND g.generation = NEW.authorization_generation
          )
          BEGIN
            SELECT RAISE(ABORT, 'workspace authorization generation is not current');
          END;
        CREATE TRIGGER user_workspace_binding_generation_update_current
          BEFORE UPDATE OF user_id, authorization_generation ON user_workspace_bindings
          WHEN NOT EXISTS(
            SELECT 1 FROM user_workspace_binding_generations g
            WHERE g.user_id = NEW.user_id AND g.generation = NEW.authorization_generation
          )
          BEGIN
            SELECT RAISE(ABORT, 'workspace authorization generation is not current');
          END;
        CREATE TRIGGER user_workspace_binding_owner_immutable
          BEFORE UPDATE OF user_id ON user_workspace_bindings
          WHEN NEW.user_id <> OLD.user_id
          BEGIN
            SELECT RAISE(ABORT, 'workspace binding owner is immutable');
          END;
        CREATE TRIGGER user_workspace_binding_identity_requires_generation
          BEFORE UPDATE OF provider_kind, machine_id ON user_workspace_bindings
          WHEN (
            NEW.provider_kind <> OLD.provider_kind
            OR NEW.machine_id <> OLD.machine_id
          ) AND NEW.authorization_generation = OLD.authorization_generation
          BEGIN
            SELECT RAISE(ABORT, 'workspace identity change requires a new generation');
          END;

        DROP TABLE desktop_access_grants;
        CREATE TABLE desktop_access_grants(
          token_digest TEXT PRIMARY KEY NOT NULL
            CHECK(length(token_digest) = 64 AND token_digest NOT GLOB '*[^0-9a-f]*'),
          owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE
            CHECK(
              length(owner_id) = 36
              AND substr(owner_id, 9, 1) = '-'
              AND substr(owner_id, 14, 1) = '-'
              AND substr(owner_id, 19, 1) = '-'
              AND substr(owner_id, 24, 1) = '-'
              AND lower(owner_id) NOT GLOB '*[^0-9a-f-]*'
            ),
          provider_kind TEXT NOT NULL
            CHECK(
              length(provider_kind) BETWEEN 1 AND 64
              AND provider_kind = lower(provider_kind)
              AND substr(provider_kind, 1, 1) GLOB '[a-z]'
              AND provider_kind NOT GLOB '*[^a-z0-9-]*'
            ),
          machine_id TEXT NOT NULL
            CHECK(
              length(machine_id) BETWEEN 1 AND 255
              AND substr(machine_id, 1, 1) GLOB '[A-Za-z0-9]'
              AND machine_id NOT GLOB '*[^A-Za-z0-9._:-]*'
            ),
          scope TEXT NOT NULL CHECK(scope IN ('desktop:view', 'desktop:control')),
          binding_generation INTEGER NOT NULL
            CHECK(typeof(binding_generation) = 'integer' AND binding_generation BETWEEN 1 AND 9007199254740991),
          created_at INTEGER NOT NULL
            CHECK(typeof(created_at) = 'integer' AND created_at BETWEEN 0 AND 9007199254740991),
          expires_at INTEGER NOT NULL
            CHECK(
              typeof(expires_at) = 'integer'
              AND expires_at > created_at
              AND expires_at <= created_at + 300000
              AND expires_at <= 9007199254740991
            ),
          revoked_at INTEGER
            CHECK(
              revoked_at IS NULL
              OR (
                typeof(revoked_at) = 'integer'
                AND revoked_at BETWEEN created_at AND 9007199254740991
              )
            )
        );
        CREATE INDEX desktop_access_grants_owner_expiry
          ON desktop_access_grants(owner_id, expires_at, token_digest);
      `);
    },
  },
  {
    // Public handles are opaque routing identifiers, never authorization.
    // The retained ledger makes a handle unavailable forever even after its
    // bot is deleted. Legacy desktop rows stay NULL; only already-owned rows
    // are backfilled.
    version: 14,
    name: "tenant-bot-public-handles",
    up(db) {
      db.exec(`
        CREATE TABLE public_bot_handles(
          handle TEXT PRIMARY KEY NOT NULL
            CHECK(length(handle) = 22 AND handle NOT GLOB '*[^A-Za-z0-9_-]*'),
          bot_id TEXT NOT NULL UNIQUE,
          created_at INTEGER NOT NULL
            CHECK(typeof(created_at) = 'integer' AND created_at BETWEEN 0 AND 9007199254740991)
        );
        ALTER TABLE bots ADD COLUMN public_handle TEXT
          REFERENCES public_bot_handles(handle) ON DELETE RESTRICT;
        CREATE UNIQUE INDEX bots_public_handle
          ON bots(public_handle) WHERE public_handle IS NOT NULL;
      `);

      const owned = db.prepare<{ id: string; created_at: number }>(
        "SELECT id, created_at FROM bots WHERE owner_id IS NOT NULL AND public_handle IS NULL ORDER BY seq",
      ).all();
      const reserve = db.prepare(
        "INSERT INTO public_bot_handles(handle, bot_id, created_at) VALUES (?, ?, ?)",
      );
      const isReserved = db.prepare("SELECT 1 FROM public_bot_handles WHERE handle = ?");
      const assign = db.prepare("UPDATE bots SET public_handle = ? WHERE id = ?");
      for (const bot of owned) {
        let handle: string | null = null;
        for (let attempt = 0; attempt < PUBLIC_BOT_HANDLE_GENERATION_ATTEMPTS; attempt++) {
          const candidate = generatePublicBotHandle();
          if (!isReserved.get(candidate)) {
            handle = candidate;
            break;
          }
        }
        // Exhaustion fails the enclosing migration transaction instead of
        // producing a partial backfill. A rerun then starts clean.
        if (!handle) throw new Error("could not reserve a unique public bot handle");
        reserve.run(handle, bot.id, bot.created_at);
        assign.run(handle, bot.id);
      }

      db.exec(`
        CREATE TRIGGER owned_bot_public_handle_required_insert
          BEFORE INSERT ON bots
          WHEN NEW.owner_id IS NOT NULL AND NEW.public_handle IS NULL
          BEGIN
            SELECT RAISE(ABORT, 'owned bot public handle is required');
          END;
        CREATE TRIGGER owned_bot_public_handle_required_update
          BEFORE UPDATE OF owner_id, public_handle ON bots
          WHEN NEW.owner_id IS NOT NULL AND NEW.public_handle IS NULL
          BEGIN
            SELECT RAISE(ABORT, 'owned bot public handle is required');
          END;
        CREATE TRIGGER legacy_bot_public_handle_forbidden_insert
          BEFORE INSERT ON bots
          WHEN NEW.owner_id IS NULL AND NEW.public_handle IS NOT NULL
          BEGIN
            SELECT RAISE(ABORT, 'legacy bot public handle is forbidden');
          END;
        CREATE TRIGGER bot_public_handle_assignment_matches_insert
          BEFORE INSERT ON bots
          WHEN NEW.public_handle IS NOT NULL AND NOT EXISTS(
            SELECT 1 FROM public_bot_handles h
            WHERE h.handle = NEW.public_handle AND h.bot_id = NEW.id
          )
          BEGIN
            SELECT RAISE(ABORT, 'bot public handle reservation mismatch');
          END;
        CREATE TRIGGER bot_public_handle_immutable
          BEFORE UPDATE OF public_handle ON bots
          WHEN OLD.public_handle IS NOT NEW.public_handle
          BEGIN
            SELECT RAISE(ABORT, 'bot public handle is immutable');
          END;
        CREATE TRIGGER public_bot_handle_reservation_immutable
          BEFORE UPDATE ON public_bot_handles
          BEGIN
            SELECT RAISE(ABORT, 'public bot handle reservation is immutable');
          END;
        CREATE TRIGGER public_bot_handle_reservation_retained
          BEFORE DELETE ON public_bot_handles
          BEGIN
            SELECT RAISE(ABORT, 'public bot handle reservation cannot be deleted');
          END;
      `);
    },
  },
  {
    // Security audit records share the durable event-log sequencer, but are
    // immutable even to repository maintenance and raw application SQL.
    // Runtime/UI events retain their existing lifecycle behavior.
    version: 15,
    name: "immutable-security-audit-events",
    up(db) {
      db.exec(`
        CREATE TRIGGER security_audit_event_no_update
          BEFORE UPDATE ON event_log
          WHEN OLD.type = 'security.audit' OR NEW.type = 'security.audit'
          BEGIN
            SELECT RAISE(ABORT, 'security audit events are append-only');
          END;
        CREATE TRIGGER security_audit_event_no_delete
          BEFORE DELETE ON event_log
          WHEN OLD.type = 'security.audit'
          BEGIN
            SELECT RAISE(ABORT, 'security audit events are append-only');
          END;
      `);
    },
  },
  {
    // SQLite REPLACE resolves uniqueness conflicts by deleting the old row
    // before inserting the replacement. Guard every conflict key explicitly
    // because delete triggers are not recursive by default.
    version: 16,
    name: "security-audit-replace-guard",
    up(db) {
      db.exec(`
        CREATE TRIGGER security_audit_event_no_replace
          BEFORE INSERT ON event_log
          WHEN EXISTS(
            SELECT 1 FROM event_log existing
            WHERE (
              existing.seq = NEW.seq OR
              (existing.stream_id = NEW.stream_id AND existing.sequence = NEW.sequence)
            )
            AND (existing.type = 'security.audit' OR NEW.type = 'security.audit')
          )
          BEGIN
            SELECT RAISE(ABORT, 'security audit events are append-only');
          END;
      `);
    },
  },
  {
    // Migration 14 originally shipped without reservation-ledger guards.
    // Keep this forward migration additive so databases that already recorded
    // tenant-bot-public-handles receive the same protections as fresh installs.
    version: 17,
    name: "retain-public-bot-handle-reservations",
    up(db) {
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS public_bot_handle_reservation_immutable
          BEFORE UPDATE ON public_bot_handles
          BEGIN
            SELECT RAISE(ABORT, 'public bot handle reservation is immutable');
          END;
        CREATE TRIGGER IF NOT EXISTS public_bot_handle_reservation_retained
          BEFORE DELETE ON public_bot_handles
          BEGIN
            SELECT RAISE(ABORT, 'public bot handle reservation cannot be deleted');
          END;
        CREATE TRIGGER IF NOT EXISTS public_bot_handle_reservation_no_replace
          BEFORE INSERT ON public_bot_handles
          WHEN EXISTS(
            SELECT 1 FROM public_bot_handles existing
            WHERE existing.handle = NEW.handle OR existing.bot_id = NEW.bot_id
          )
          BEGIN
            SELECT RAISE(ABORT, 'public bot handle reservation cannot be replaced');
          END;
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
