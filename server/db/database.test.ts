// Migration suite: schema application, idempotence, and the durability
// pragmas the rest of P0.4 relies on.
import { rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "../config.ts";
import { defaultDbPath, openDatabase } from "./database.ts";
import { appliedMigrations, isApplied, migrate, MIGRATIONS, recordApplied } from "./migrations.ts";
import type { SqliteDatabase } from "./sqlite-native.ts";

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

  (process.platform === "win32" ? it.skip : it)("keeps the database file user-private (0600)", () => {
    db = openDatabase(defaultDbPath());
    db.prepare("INSERT INTO threads(id, bot_id, created_at) VALUES ('t', NULL, 1)").run();
    expect(statSync(defaultDbPath()).mode & 0o777).toBe(0o600);
    expect(statSync(DATA_DIR).mode & 0o777).toBe(0o700);
  });
});
