// Migration suite: schema application, idempotence, and the durability
// pragmas the rest of P0.4 relies on.
import { mkdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "../config.ts";
import { defaultDbPath, openDatabase } from "./database.ts";
import { appliedMigrations, isApplied, migrate, MIGRATIONS, recordApplied } from "./migrations.ts";
import { loadBetterSqlite3, type SqliteDatabase } from "./sqlite-native.ts";

const MANDATED_TABLES = [
  "schema_migrations",
  "bots",
  "threads",
  "messages",
  "event_log",
  "routines",
  "routine_runs",
  "approval_rules",
  "approval_audit",
  "skills",
  "computer_bindings",
  "memory",
  "memory_rows",
  "groups",
  "users",
  "sessions",
  "user_workspace_bindings",
  "github_oauth_transactions",
  "desktop_access_grants",
];

describe("database + migrations", () => {
  let db: SqliteDatabase | null = null;
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });
  afterEach(() => {
    try {
      db?.close();
    } catch {
      /* already closed */
    }
    db = null;
  });

  it("creates every mandated table with WAL + foreign keys on", () => {
    db = openDatabase(defaultDbPath());
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    const tables = db
      .prepare<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((r) => r.name)
      .sort();
    expect(tables).toEqual([...MANDATED_TABLES].sort());
  });

  it("migration is idempotent: a rerun applies nothing and changes nothing", () => {
    db = openDatabase(defaultDbPath());
    const first = appliedMigrations(db);
    expect(first.map((m) => m.name)).toEqual(MIGRATIONS.map((m) => m.name));
    expect(migrate(db)).toEqual([]);
    expect(appliedMigrations(db)).toEqual(first);
    // and across a full close/reopen of the same file
    db.close();
    db = openDatabase(defaultDbPath());
    expect(appliedMigrations(db)).toEqual(first);
  });

  it("backfills only owned bot threads and preserves legacy, group, and orphan threads as unowned", () => {
    mkdirSync(DATA_DIR, { recursive: true });
    db = new (loadBetterSqlite3())(join(DATA_DIR, "pre-ownership.db"));
    migrate(db, MIGRATIONS.slice(0, 6));
    const ownerId = "11111111-1111-4111-8111-111111111111";
    db.prepare(
      "INSERT INTO users(id, github_id, github_login, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run(ownerId, 101, "owner", 1_000, 1_000);
    db.prepare("INSERT INTO threads(id, bot_id, created_at) VALUES (?, ?, ?)").run("legacy-thread", "legacy-bot", 1_000);
    db.prepare("INSERT INTO bots(id, thread_id, created_at, data) VALUES (?, ?, ?, ?)").run(
      "legacy-bot",
      "legacy-thread",
      1_000,
      JSON.stringify({ id: "legacy-bot" }),
    );
    db.prepare("INSERT INTO threads(id, bot_id, created_at) VALUES (?, ?, ?)").run("group-thread", null, 1_000);
    db.prepare("INSERT INTO groups(id, thread_id, created_at, data) VALUES (?, ?, ?, ?)").run(
      "group-1",
      "group-thread",
      1_000,
      JSON.stringify({ id: "group-1" }),
    );
    db.prepare("INSERT INTO threads(id, bot_id, created_at) VALUES (?, ?, ?)").run("orphan-thread", null, 1_000);

    expect(migrate(db, [MIGRATIONS[6]])).toEqual(["bot-user-ownership"]);
    db.prepare("INSERT INTO threads(id, bot_id, created_at) VALUES (?, ?, ?)").run("owned-thread", "owned-bot", 2_000);
    db.prepare("INSERT INTO bots(id, thread_id, created_at, data, owner_id) VALUES (?, ?, ?, ?, ?)").run(
      "owned-bot",
      "owned-thread",
      2_000,
      JSON.stringify({ id: "owned-bot" }),
      ownerId,
    );

    expect(migrate(db)).toEqual([
      "thread-user-ownership",
      "group-user-ownership",
      "user-workspace-bindings",
      "github-oauth-transactions",
      "desktop-access-grants",
    ]);
    expect(db.prepare<{ owner_id: string | null }>("SELECT owner_id FROM bots WHERE id = ?").get("legacy-bot")).toEqual({
      owner_id: null,
    });
    expect(
      db.prepare<{ id: string; owner_id: string | null }>("SELECT id, owner_id FROM threads ORDER BY id").all(),
    ).toEqual([
      { id: "group-thread", owner_id: null },
      { id: "legacy-thread", owner_id: null },
      { id: "orphan-thread", owner_id: null },
      { id: "owned-thread", owner_id: ownerId },
    ]);
    expect(
      db
        .prepare<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'bots_owner_%' ORDER BY name")
        .all()
        .map(({ name }) => name),
    ).toEqual(["bots_owner_seq", "bots_owner_thread"]);
    expect(
      db.prepare<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'threads_owner_id'").get(),
    ).toEqual({ name: "threads_owner_id" });
    expect(migrate(db)).toEqual([]);
    expect(db.prepare<{ n: number }>("SELECT count(*) AS n FROM bots").get()?.n).toBe(2);
    expect(db.prepare<{ n: number }>("SELECT count(*) AS n FROM threads").get()?.n).toBe(4);
  });

  it("adds group ownership without claiming legacy groups or their threads", () => {
    mkdirSync(DATA_DIR, { recursive: true });
    db = new (loadBetterSqlite3())(join(DATA_DIR, "pre-group-ownership.db"));
    migrate(db, MIGRATIONS.slice(0, 8));
    db.prepare("INSERT INTO threads(id, bot_id, created_at) VALUES (?, NULL, ?)").run("legacy-group-thread", 1_000);
    db.prepare("INSERT INTO groups(id, thread_id, created_at, data) VALUES (?, ?, ?, ?)").run(
      "legacy-group",
      "legacy-group-thread",
      1_000,
      JSON.stringify({
        id: "legacy-group",
        threadId: "legacy-group-thread",
        name: "Legacy",
        memberIds: [],
        unread: false,
        createdAt: 1_000,
      }),
    );

    expect(migrate(db)).toEqual([
      "group-user-ownership",
      "user-workspace-bindings",
      "github-oauth-transactions",
      "desktop-access-grants",
    ]);
    expect(db.prepare<{ owner_id: string | null }>("SELECT owner_id FROM groups WHERE id = ?").get("legacy-group")).toEqual({
      owner_id: null,
    });
    expect(db.prepare<{ owner_id: string | null }>("SELECT owner_id FROM threads WHERE id = ?").get("legacy-group-thread")).toEqual({
      owner_id: null,
    });
    expect(
      db
        .prepare<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'groups_owner_%' ORDER BY name")
        .all()
        .map(({ name }) => name),
    ).toEqual(["groups_owner_seq", "groups_owner_thread"]);
    expect(migrate(db)).toEqual([]);
  });

  it("adds an empty user workspace seam without claiming legacy desktop bindings", () => {
    mkdirSync(DATA_DIR, { recursive: true });
    db = new (loadBetterSqlite3())(join(DATA_DIR, "pre-user-workspace.db"));
    migrate(db, MIGRATIONS.slice(0, 9));
    db.prepare(
      "INSERT INTO computer_bindings(bot_id, box_id, created_at, updated_at) VALUES (?, ?, ?, ?)",
    ).run("legacy-bot", "legacy-machine", 1_000, 2_000);

    expect(migrate(db)).toEqual(["user-workspace-bindings", "github-oauth-transactions", "desktop-access-grants"]);
    expect(db.prepare<{ n: number }>("SELECT count(*) AS n FROM user_workspace_bindings").get()?.n).toBe(0);
    expect(
      db
        .prepare<{ bot_id: string; box_id: string; created_at: number; updated_at: number }>(
          "SELECT bot_id, box_id, created_at, updated_at FROM computer_bindings",
        )
        .all(),
    ).toEqual([{ bot_id: "legacy-bot", box_id: "legacy-machine", created_at: 1_000, updated_at: 2_000 }]);
    expect(migrate(db)).toEqual([]);
  });

  it("backfills legacy routine_runs rows: open rows close as interrupted", () => {
    // build a v1 database the way a pre-P1.2 build left it, then apply v2
    mkdirSync(DATA_DIR, { recursive: true });
    db = new (loadBetterSqlite3())(join(DATA_DIR, "legacy.db"));
    migrate(db, [MIGRATIONS[0]]);
    db.prepare("INSERT INTO routine_runs(routine_id, bot_id, started_at, finished_at, result) VALUES ('r1', 'b1', 1000, 2000, 'DONE')").run();
    db.prepare("INSERT INTO routine_runs(routine_id, bot_id, started_at, finished_at, result) VALUES ('r1', 'b1', 3000, 4000, 'BLOCKED: x')").run();
    db.prepare("INSERT INTO routine_runs(routine_id, bot_id, started_at) VALUES ('r1', 'b1', 5000)").run(); // crashed mid-run
    expect(migrate(db)).toEqual(MIGRATIONS.slice(1).map((m) => m.name));
    const rows = db
      .prepare<{ started_at: number; finished_at: number | null; status: string; result: string; attempt: number }>(
        "SELECT started_at, finished_at, status, result, attempt FROM routine_runs ORDER BY seq",
      )
      .all();
    expect(rows).toEqual([
      { started_at: 1000, finished_at: 2000, status: "done", result: "DONE", attempt: 1 },
      { started_at: 3000, finished_at: 4000, status: "blocked", result: "BLOCKED: x", attempt: 1 },
      { started_at: 5000, finished_at: 5000, status: "interrupted", result: "interrupted: VelarixBot quit mid-run", attempt: 1 },
    ]);
  });

  it("applies migrations transactionally and records completion once", () => {
    db = openDatabase(join(DATA_DIR, "scratch.db"));
    const broken = {
      version: 999,
      name: "explodes",
      up() {
        throw new Error("boom");
      },
    };
    expect(() => migrate(db!, [broken])).toThrow(/boom/);
    expect(isApplied(db, "explodes")).toBe(false);
    recordApplied(db, { name: "explodes", version: 999 });
    expect(migrate(db, [broken])).toEqual([]); // recorded → skipped, no rethrow
  });

  (process.platform === "win32" ? it.skip : it)("keeps the database file user-private (0600) — POSIX-only: Windows has no Unix 0600 mode bits", () => {
    db = openDatabase(defaultDbPath());
    db.prepare("INSERT INTO threads(id, bot_id, created_at) VALUES ('t', NULL, 1)").run();
    expect(statSync(defaultDbPath()).mode & 0o777).toBe(0o600);
    expect(statSync(DATA_DIR).mode & 0o777).toBe(0o700);
  });
});
