// P1.3 — the event log as a per-stream sequencer: schemaVersion / streamId /
// sequence stamps, gap-free per-stream ordering, replay, and the migration
// that backfills sequences onto a pre-P1.3 event_log.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EVENT_SCHEMA_VERSION, type RuntimeEvent } from "../contracts.ts";
import { openDatabase } from "../db/database.ts";
import { MIGRATIONS, migrate } from "../db/migrations.ts";
import { loadBetterSqlite3, type SqliteDatabase } from "../db/sqlite-native.ts";
import { createEventLogRepository, UI_STREAM_ID } from "./event-log.ts";

function runtimeEvent(threadId: string, n: number): RuntimeEvent {
  return {
    type: "turn.started",
    eventId: `ev-${threadId}-${n}`,
    provider: "fake",
    threadId,
    createdAt: new Date(1_700_000_000_000 + n).toISOString(),
  };
}

describe("event log per-stream sequences (P1.3)", () => {
  let dir: string;
  let db: SqliteDatabase;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omb-eventlog-"));
    db = openDatabase(join(dir, "test.db"));
  });
  afterEach(() => {
    try {
      db.close();
    } catch {
      /* already closed */
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("stamps schemaVersion/streamId/sequence on runtime events, per-thread and gap-free", () => {
    const log = createEventLogRepository(db);
    const a1 = log.append(runtimeEvent("thread-a", 1));
    const a2 = log.append(runtimeEvent("thread-a", 2));
    const b1 = log.append(runtimeEvent("thread-b", 1));
    const a3 = log.append(runtimeEvent("thread-a", 3));

    // the stamps land ON the event (the bus hands this same object to
    // later subscribers) and in the persisted copy
    expect(a1).toMatchObject({ schemaVersion: EVENT_SCHEMA_VERSION, streamId: "thread-a", sequence: 1 });
    expect(a2).toMatchObject({ streamId: "thread-a", sequence: 2 });
    expect(a3).toMatchObject({ streamId: "thread-a", sequence: 3 });
    expect(b1).toMatchObject({ streamId: "thread-b", sequence: 1 }); // independent stream

    expect(log.forThread("thread-a").map((e) => e.sequence)).toEqual([1, 2, 3]);
    expect(log.forThread("thread-a")[0]).toMatchObject({ schemaVersion: EVENT_SCHEMA_VERSION, streamId: "thread-a" });
    expect(log.latestSequence("thread-a")).toBe(3);
    expect(log.latestSequence("thread-b")).toBe(1);
    expect(log.latestSequence("missing")).toBe(0);
  });

  it("sequences arbitrary payloads on a named stream and replays exactly the suffix", () => {
    const log = createEventLogRepository(db);
    const first = log.appendToStream(UI_STREAM_ID, "bot", { kind: "bot", bot: { id: "b1", name: "one" } });
    const second = log.appendToStream(UI_STREAM_ID, "bot", { kind: "bot", bot: { id: "b1", name: "two" } });
    const third = log.appendToStream(UI_STREAM_ID, "message", { kind: "message", threadId: "t", message: { id: "m1" } });

    expect([first.sequence, second.sequence, third.sequence]).toEqual([1, 2, 3]);
    expect(first.payload).toMatchObject({ kind: "bot", schemaVersion: EVENT_SCHEMA_VERSION, streamId: UI_STREAM_ID, sequence: 1 });

    // replay is the exact ordered suffix — no gaps, no repeats, nothing before the cursor
    expect(log.replayAfter(UI_STREAM_ID, 0).map((e) => e.sequence)).toEqual([1, 2, 3]);
    expect(log.replayAfter(UI_STREAM_ID, 1).map((e) => e.sequence)).toEqual([2, 3]);
    expect(log.replayAfter(UI_STREAM_ID, 3)).toEqual([]);
    expect(log.replayAfter(UI_STREAM_ID, 2)[0].payload).toMatchObject({ kind: "message", sequence: 3 });
    expect(log.latestSequence(UI_STREAM_ID)).toBe(3);
    expect(log.oldestSequence(UI_STREAM_ID)).toBe(1);
    expect(log.oldestSequence("empty")).toBe(0);

    // the ui stream does not bleed into thread streams
    expect(log.latestSequence("t")).toBe(0);
  });

  it("recentMeta returns metadata only — never the data payload (P1.7 diagnostics)", () => {
    const log = createEventLogRepository(db);
    const secretPayload = { ...runtimeEvent("thread-a", 1), transcript: "TRANSCRIPT-CANARY-nothing-may-export-this" };
    log.append(secretPayload as RuntimeEvent);
    log.append(runtimeEvent("thread-a", 2));
    log.append(runtimeEvent("thread-b", 1));

    const meta = log.recentMeta(2);
    expect(meta).toHaveLength(2); // newest 2, oldest first
    expect(meta.map((m) => m.eventId)).toEqual(["ev-thread-a-2", "ev-thread-b-1"]);
    expect(meta[0]).toMatchObject({ threadId: "thread-a", type: "turn.started", streamId: "thread-a", sequence: 2 });
    expect(JSON.stringify(log.recentMeta(10))).not.toContain("TRANSCRIPT-CANARY");
    expect(log.count()).toBe(3);
  });

  it("survives a reopen: sequences continue where the durable log left off", () => {
    let log = createEventLogRepository(db);
    log.appendToStream(UI_STREAM_ID, "bot", { kind: "bot" });
    log.appendToStream(UI_STREAM_ID, "bot", { kind: "bot" });
    db.close();

    db = openDatabase(join(dir, "test.db"));
    log = createEventLogRepository(db);
    expect(log.latestSequence(UI_STREAM_ID)).toBe(2);
    expect(log.appendToStream(UI_STREAM_ID, "bot", { kind: "bot" }).sequence).toBe(3);
  });
});

describe("migration 2: event-log-stream-sequences backfill", () => {
  it("backfills per-thread sequences onto pre-P1.3 rows and keeps counting after", () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-eventlog-migrate-"));
    const Database = loadBetterSqlite3();
    const db = new Database(join(dir, "legacy.db"));
    try {
      // a P0.4-era database: schema v1 only, three legacy rows across two threads
      migrate(db, [MIGRATIONS[0]]);
      const insert = db.prepare("INSERT INTO event_log(event_id, thread_id, type, created_at, data) VALUES (?, ?, ?, ?, ?)");
      insert.run("e1", "thread-a", "turn.started", "t1", JSON.stringify({ eventId: "e1" }));
      insert.run("e2", "thread-b", "turn.started", "t2", JSON.stringify({ eventId: "e2" }));
      insert.run("e3", "thread-a", "turn.completed", "t3", JSON.stringify({ eventId: "e3" }));

      expect(migrate(db)).toEqual(["routine-run-durability", "event-log-stream-sequences"]);
      const rows = db
        .prepare<{ event_id: string; stream_id: string; sequence: number; schema_version: number }>(
          "SELECT event_id, stream_id, sequence, schema_version FROM event_log ORDER BY seq",
        )
        .all();
      expect(rows).toEqual([
        { event_id: "e1", stream_id: "thread-a", sequence: 1, schema_version: 1 },
        { event_id: "e2", stream_id: "thread-b", sequence: 1, schema_version: 1 },
        { event_id: "e3", stream_id: "thread-a", sequence: 2, schema_version: 1 },
      ]);

      // rerun is a no-op (append-only, idempotent) and appends keep counting
      expect(migrate(db)).toEqual([]);
      const log = createEventLogRepository(db);
      expect(log.append(runtimeEvent("thread-a", 4))).toMatchObject({ streamId: "thread-a", sequence: 3 });
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
