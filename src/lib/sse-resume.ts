// P1.3 client half of the resumable SSE stream. The server persists every
// semantic frame on a durable per-stream sequence and sends it as the SSE
// `id:`; the renderer keeps a cursor of the last applied (streamId,
// sequence) and (a) reconnects from it — a fresh EventSource cannot set the
// Last-Event-ID header, so the cursor rides ?lastEventId= — and (b) skips
// any frame at or before the cursor, so a reconnect/replay overlap can
// never double-apply an event.

export interface SseCursor {
  streamId: string | null;
  sequence: number;
}

export const INITIAL_CURSOR: SseCursor = { streamId: null, sequence: 0 };

interface StampedFrame {
  streamId?: unknown;
  sequence?: unknown;
  [k: string]: unknown;
}

function frameStamp(frame: StampedFrame): { streamId: string; sequence: number } | null {
  if (typeof frame.streamId !== "string" || typeof frame.sequence !== "number") return null;
  return { streamId: frame.streamId, sequence: frame.sequence };
}

/** False only for duplicates: a sequenced frame of the cursor's stream at
 * or before the cursor (already applied). Unsequenced frames are ephemeral
 * (deltas, live screen frames) and always apply. */
export function shouldApplyFrame(cursor: SseCursor, frame: StampedFrame): boolean {
  const stamp = frameStamp(frame);
  if (!stamp) return true;
  if (cursor.streamId !== stamp.streamId) return true;
  return stamp.sequence > cursor.sequence;
}

/** Cursor after applying `frame` — advances monotonically per stream. */
export function advanceCursor(cursor: SseCursor, frame: StampedFrame): SseCursor {
  const stamp = frameStamp(frame);
  if (!stamp) return cursor;
  if (cursor.streamId === stamp.streamId && stamp.sequence <= cursor.sequence) return cursor;
  return { streamId: stamp.streamId, sequence: stamp.sequence };
}

/** The subscribe URL for a cursor: resume when we hold one, plain otherwise. */
export function eventsUrl(cursor: SseCursor): string {
  return cursor.streamId === null ? "/api/events" : `/api/events?lastEventId=${cursor.sequence}`;
}
