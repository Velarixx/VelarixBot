// Canonical runtime events, mirrored into SQLite by the composition root's
// bus subscription. The per-thread NDJSON files under ~/.velarixbot/events
// stay as the export surface (harness/bus.ts, unchanged) — this table is
// the queryable durable copy.
import type { RuntimeEvent } from "../contracts.ts";
import type { SqliteDatabase } from "../db/sqlite-native.ts";

export interface EventLogRow {
  seq: number;
  event_id: string;
  thread_id: string;
  type: string;
  created_at: string;
  data: string;
}

export interface EventLogRepository {
  append(event: RuntimeEvent): void;
  forThread(threadId: string): RuntimeEvent[];
  countForThread(threadId: string): number;
}

export function createEventLogRepository(db: SqliteDatabase): EventLogRepository {
  const insert = db.prepare("INSERT INTO event_log(event_id, thread_id, type, created_at, data) VALUES (?, ?, ?, ?, ?)");
  const selectThread = db.prepare<EventLogRow>(
    "SELECT seq, event_id, thread_id, type, created_at, data FROM event_log WHERE thread_id = ? ORDER BY seq",
  );
  const countThread = db.prepare<{ n: number }>("SELECT count(*) AS n FROM event_log WHERE thread_id = ?");

  return {
    append(event) {
      insert.run(event.eventId, event.threadId, event.type, event.createdAt, JSON.stringify(event));
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
  };
}
