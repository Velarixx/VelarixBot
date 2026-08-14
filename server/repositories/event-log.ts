// Canonical runtime events, mirrored into SQLite by the composition root's
// bus subscription. The per-thread NDJSON files under ~/.velarixbot/events
// stay as the export surface (harness/bus.ts, unchanged) — this table is
// the queryable durable copy.
//
// P1.3: the table is also the durable per-stream sequencer. Every persisted
// event is stamped with { schemaVersion, streamId, sequence } — runtime
// events sequence on their thread's stream, and the SSE hub persists the
// renderer-facing frames on its own stream (UI_STREAM_ID) so a client can
// replay from Last-Event-ID with zero loss and zero dupes.
import { EVENT_SCHEMA_VERSION, newEventId, type RuntimeEvent } from "../contracts.ts";
import type { SqliteDatabase } from "../db/sqlite-native.ts";

/** The SSE hub's durable stream of renderer frames. */
export const UI_STREAM_ID = "ui";

export interface EventLogRow {
  seq: number;
  event_id: string;
  thread_id: string;
  type: string;
  created_at: string;
  data: string;
  stream_id: string;
  sequence: number;
  schema_version: number;
}

/** One replayable entry of a stream: the per-stream sequence plus the
 * stamped payload exactly as it was persisted. */
export interface StreamEntry {
  sequence: number;
  payload: Record<string, unknown>;
}

export interface EventLogRepository {
  /** Persist a runtime event on its thread's stream. Stamps schemaVersion /
   * streamId / sequence ON the event (in place) so every later consumer in
   * the same bus dispatch sees the sequenced copy, and returns it. */
  append(event: RuntimeEvent): RuntimeEvent;
  forThread(threadId: string): RuntimeEvent[];
  countForThread(threadId: string): number;
  /** Persist an arbitrary payload on a named stream (the SSE hub's ui
   * stream). Returns the stamped payload with its assigned sequence. */
  appendToStream(streamId: string, type: string, payload: Record<string, unknown>): StreamEntry;
  /** Every persisted entry of `streamId` with sequence > after, in order. */
  replayAfter(streamId: string, after: number): StreamEntry[];
  /** Highest assigned sequence on the stream (0 when empty). */
  latestSequence(streamId: string): number;
  /** Lowest retained sequence on the stream (0 when empty) — replay from
   * `after` is complete only when after >= oldest - 1. */
  oldestSequence(streamId: string): number;
}

export function createEventLogRepository(db: SqliteDatabase): EventLogRepository {
  const insert = db.prepare(
    "INSERT INTO event_log(event_id, thread_id, type, created_at, data, stream_id, sequence, schema_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const selectThread = db.prepare<EventLogRow>(
    "SELECT seq, event_id, thread_id, type, created_at, data FROM event_log WHERE thread_id = ? ORDER BY seq",
  );
  const countThread = db.prepare<{ n: number }>("SELECT count(*) AS n FROM event_log WHERE thread_id = ?");
  const nextSeq = db.prepare<{ n: number }>("SELECT COALESCE(MAX(sequence), 0) + 1 AS n FROM event_log WHERE stream_id = ?");
  const latestSeq = db.prepare<{ n: number }>("SELECT COALESCE(MAX(sequence), 0) AS n FROM event_log WHERE stream_id = ?");
  const oldestSeq = db.prepare<{ n: number }>("SELECT COALESCE(MIN(sequence), 0) AS n FROM event_log WHERE stream_id = ?");
  const selectStream = db.prepare<{ sequence: number; data: string }>(
    "SELECT sequence, data FROM event_log WHERE stream_id = ? AND sequence > ? ORDER BY sequence",
  );

  // sequence assignment + insert must be one atomic step so two appends
  // can never race to the same (stream_id, sequence) pair
  const appendRow = db.transaction(
    (row: { eventId: string; threadId: string; type: string; createdAt: string; streamId: string; stamp: (sequence: number) => string }): number => {
      const sequence = nextSeq.get(row.streamId)?.n ?? 1;
      insert.run(row.eventId, row.threadId, row.type, row.createdAt, row.stamp(sequence), row.streamId, sequence, EVENT_SCHEMA_VERSION);
      return sequence;
    },
  );

  return {
    append(event) {
      // stamp in place: the bus delivers this same object to the SSE
      // broadcaster after us, so the wire copy carries the stamps too
      appendRow({
        eventId: event.eventId,
        threadId: event.threadId,
        type: event.type,
        createdAt: event.createdAt,
        streamId: event.threadId,
        stamp: (sequence) => {
          event.schemaVersion = EVENT_SCHEMA_VERSION;
          event.streamId = event.threadId;
          event.sequence = sequence;
          return JSON.stringify(event);
        },
      });
      return event;
    },
    forThread(threadId) {
      const out: RuntimeEvent[] = [];
      for (const row of selectThread.all(threadId)) {
        try {
          out.push(JSON.parse(row.data) as RuntimeEvent);
        } catch {
          /* skip a torn import line */
        }
      }
      return out;
    },
    countForThread(threadId) {
      return countThread.get(threadId)?.n ?? 0;
    },
    appendToStream(streamId, type, payload) {
      let stamped: Record<string, unknown> = payload;
      const sequence = appendRow({
        eventId: newEventId(),
        threadId: streamId, // the column is NOT NULL; a non-thread stream is its own bucket
        type,
        createdAt: new Date().toISOString(),
        streamId,
        stamp: (seq) => {
          stamped = { ...payload, schemaVersion: EVENT_SCHEMA_VERSION, streamId, sequence: seq };
          return JSON.stringify(stamped);
        },
      });
      return { sequence, payload: stamped };
    },
    replayAfter(streamId, after) {
      const out: StreamEntry[] = [];
      for (const row of selectStream.all(streamId, after)) {
        try {
          out.push({ sequence: row.sequence, payload: JSON.parse(row.data) as Record<string, unknown> });
        } catch {
          /* skip a torn import line */
        }
      }
      return out;
    },
    latestSequence(streamId) {
      return latestSeq.get(streamId)?.n ?? 0;
    },
    oldestSequence(streamId) {
      return oldestSeq.get(streamId)?.n ?? 0;
    },
  };
}
