// NDJSON export / restore of the whole database. One line per row, a meta
// header, inline base64 blob lines for every referenced screenshot (the
// export file is self-contained), and a trailing checksum line so restore
// can prove it read exactly what export wrote. Written with the P0.2
// atomic-write path (fsync + 0600).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { atomicWriteFileSync } from "../atomic.ts";
import { putBlobBase64, readBlobBase64 } from "./blobs.ts";
import type { SqliteDatabase } from "./sqlite-native.ts";

export const EXPORT_FORMAT = "velarixbot-export";
export const EXPORT_VERSION = 1;

/** Domain tables in FK-safe insert order (threads before bots/messages).
 * schema_migrations is deliberately not exported: the restore target runs
 * its own migrations. */
export const EXPORT_TABLES: Array<{ table: string; columns: string[] }> = [
  { table: "threads", columns: ["id", "bot_id", "created_at"] },
  { table: "bots", columns: ["seq", "id", "thread_id", "created_at", "data"] },
  { table: "messages", columns: ["seq", "id", "thread_id", "at", "png_hash", "data"] },
  { table: "event_log", columns: ["seq", "event_id", "thread_id", "type", "created_at", "data"] },
  { table: "routines", columns: ["seq", "id", "bot_id", "created_at", "data"] },
  {
    table: "routine_runs",
    columns: ["seq", "routine_id", "bot_id", "started_at", "finished_at", "result", "scheduled_for", "kind", "status", "attempt", "idempotency_key", "lease_until"],
  },
  { table: "approval_rules", columns: ["scope", "id", "tool", "pattern", "action", "created_at", "disabled", "quarantined", "confirmed"] },
  { table: "approval_audit", columns: ["seq", "at", "bot", "tool", "matcher", "decision", "rule_id"] },
  { table: "skills", columns: ["id", "name", "bot_id", "markdown", "created_at"] },
  { table: "memory", columns: ["owner", "user_text", "distilled_text", "updated_at"] },
  { table: "computer_bindings", columns: ["bot_id", "box_id", "created_at", "updated_at"] },
];

function checksumOf(lines: string[]): string {
  return createHash("sha256").update(lines.join("\n"), "utf8").digest("hex");
}

export interface ExportResult {
  rows: number;
  blobs: number;
  sha256: string;
}

export function exportNdjson(db: SqliteDatabase, outPath: string): ExportResult {
  const lines: string[] = [];
  lines.push(JSON.stringify({ kind: "meta", format: EXPORT_FORMAT, version: EXPORT_VERSION, exportedAt: Date.now() }));
  let rows = 0;
  let blobs = 0;
  const seenHashes = new Set<string>();
  for (const { table, columns } of EXPORT_TABLES) {
    const all = db.prepare<Record<string, unknown>>(`SELECT ${columns.join(", ")} FROM ${table} ORDER BY rowid`).all();
    for (const row of all) {
      lines.push(JSON.stringify({ kind: "row", table, row }));
      rows++;
      const hash = table === "messages" ? (row.png_hash as string | null) : null;
      if (hash && !seenHashes.has(hash)) {
        seenHashes.add(hash);
        const data = readBlobBase64(hash);
        if (data !== null) {
          lines.push(JSON.stringify({ kind: "blob", hash, data }));
          blobs++;
        }
      }
    }
  }
  const sha256 = checksumOf(lines);
  lines.push(JSON.stringify({ kind: "checksum", sha256, rows, blobs }));
  atomicWriteFileSync(outPath, lines.join("\n") + "\n");
  return { rows, blobs, sha256 };
}

export interface RestoreResult {
  rows: number;
  blobs: number;
}

/** Restore an export into a migrated database. All-or-nothing: the target's
 * domain tables are replaced inside one transaction; a checksum mismatch or
 * malformed line aborts before anything is touched. */
export function restoreNdjson(db: SqliteDatabase, inPath: string): RestoreResult {
  const lines = readFileSync(inPath, "utf8").split("\n").filter(Boolean);
  if (!lines.length) throw new Error("empty export file");
  const meta = JSON.parse(lines[0]) as { kind?: string; format?: string; version?: number };
  if (meta.kind !== "meta" || meta.format !== EXPORT_FORMAT) throw new Error("not a velarixbot export file");
  if (meta.version !== EXPORT_VERSION) throw new Error(`unsupported export version ${meta.version}`);
  const trailer = JSON.parse(lines[lines.length - 1]) as { kind?: string; sha256?: string; rows?: number };
  if (trailer.kind !== "checksum" || typeof trailer.sha256 !== "string") throw new Error("export file has no checksum trailer");
  const body = lines.slice(0, -1);
  const actual = checksumOf(body);
  if (actual !== trailer.sha256) {
    throw new Error(`export checksum mismatch: file says ${trailer.sha256}, content is ${actual}`);
  }

  const rowLines: Array<{ table: string; row: Record<string, unknown> }> = [];
  const blobLines: Array<{ hash: string; data: string }> = [];
  for (const line of body.slice(1)) {
    const parsed = JSON.parse(line) as { kind?: string; table?: string; row?: Record<string, unknown>; hash?: string; data?: string };
    if (parsed.kind === "row" && parsed.table && parsed.row) rowLines.push({ table: parsed.table, row: parsed.row });
    else if (parsed.kind === "blob" && parsed.hash && typeof parsed.data === "string") blobLines.push({ hash: parsed.hash, data: parsed.data });
    else throw new Error("malformed export line");
  }
  const known = new Map(EXPORT_TABLES.map((t) => [t.table, t.columns]));
  for (const { table } of rowLines) {
    if (!known.has(table)) throw new Error(`export references unknown table ${table}`);
  }

  // blobs first (content-addressed: idempotent, harmless if the transaction
  // below rolls back)
  for (const blob of blobLines) putBlobBase64(blob.data);

  db.transaction(() => {
    for (const { table } of [...EXPORT_TABLES].reverse()) db.prepare(`DELETE FROM ${table}`).run();
    for (const { table, row } of rowLines) {
      const columns = known.get(table)!;
      const insert = db.prepare(`INSERT INTO ${table}(${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`);
      insert.run(...columns.map((c) => (row[c] === undefined ? null : row[c])));
    }
  })();

  return { rows: rowLines.length, blobs: blobLines.length };
}
