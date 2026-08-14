// The ONE module allowed to load better-sqlite3 — nothing else in server/
// may require or import it (import-hygiene.test.ts enforces both).
//
// Why a native addon is acceptable here at all (the packaging hazard): the
// packaged app ships dist-server with NO node_modules, so a bare import
// would crash the installer. better-sqlite3 v12+ is an N-API addon and
// ships prebuilt binaries for every platform INSIDE the npm package
// (prebuilds/<platform>-<arch>.node). N-API binaries are ABI-stable across
// Node and Electron, so the SAME staged package loads in all three runtimes
// that run this code:
//   - dev / CI:          `node server/index.ts` → repo node_modules
//   - packaged Electron: utilityProcess forks resources/server/index.js;
//                        scripts/stage-sqlite.mjs copies the package to
//                        resources/server-deps/better-sqlite3 (extraResources)
//                        and this loader finds it as a sibling of dist-server
//   - release smoke:     plain `node resources/server/index.js` — same
//                        staged copy, same N-API binary
// The lookup is createRequire (CommonJS), NOT a static import, so the
// import-hygiene packaging guard keeps protecting every other server file.
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const cjsRequire = createRequire(import.meta.url);
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

/** Minimal typed surface of better-sqlite3 that this codebase uses —
 * declared here so no other module needs @types or the package itself. */
export interface SqliteRunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface SqliteStatement<Row = unknown> {
  run(...params: unknown[]): SqliteRunResult;
  get(...params: unknown[]): Row | undefined;
  all(...params: unknown[]): Row[];
}

export interface SqliteDatabase {
  readonly name: string;
  readonly open: boolean;
  readonly inTransaction: boolean;
  prepare<Row = unknown>(sql: string): SqliteStatement<Row>;
  exec(sql: string): unknown;
  pragma(sql: string, options?: { simple?: boolean }): unknown;
  transaction<Args extends unknown[], Result>(fn: (...args: Args) => Result): (...args: Args) => Result;
  close(): void;
}

export type SqliteDatabaseCtor = new (path: string) => SqliteDatabase;

/** Packaged layout: dist-server is copied to resources/server, the staged
 * dependency to resources/server-deps/better-sqlite3. This compiled file
 * lives at resources/server/db/sqlite-native.js, so the staged package is
 * two levels up. OMB_SQLITE_DIR is the explicit override (tests, tools). */
export function resolveBetterSqlite3(): string {
  const override = process.env.OMB_SQLITE_DIR;
  if (override) return override;
  const staged = join(MODULE_DIR, "..", "..", "server-deps", "better-sqlite3");
  if (existsSync(join(staged, "package.json"))) return staged;
  return "better-sqlite3";
}

let ctor: SqliteDatabaseCtor | null = null;

export function loadBetterSqlite3(): SqliteDatabaseCtor {
  if (!ctor) {
    const target = resolveBetterSqlite3();
    try {
      ctor = cjsRequire(target) as SqliteDatabaseCtor;
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      throw new Error(
        `could not load better-sqlite3 from "${target}". ` +
          `Packaged installs must ship resources/server-deps/better-sqlite3 ` +
          `(scripts/stage-sqlite.mjs); dev needs pnpm install. ${detail}`,
      );
    }
  }
  return ctor;
}
