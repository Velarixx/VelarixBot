// SSE fan-out to clients. One hub per application; routes attach response
// streams, services broadcast frames.
//
// P1.3 — resumable stream. Semantic frames are persisted on the durable
// "ui" stream (SQLite event_log via the injected UiEventStream) and sent
// with an SSE `id:` equal to their per-stream sequence; a client reconnects
// with Last-Event-ID (header, or ?lastEventId= for a fresh EventSource
// after a renderer reload) and the hub replays exactly the missed frames —
// zero loss, zero dupes. High-churn delta frames (content.delta chunks,
// live screen captures) are deliberately NOT persisted and carry no `id:`:
// they coalesce into the committed message/bot frames that ARE replayed,
// so a resume never needs them.
import type { IncomingMessage, ServerResponse } from "node:http";

import { EVENT_SCHEMA_VERSION } from "../contracts.ts";
import type { StreamEntry } from "../repositories/event-log.ts";

export type Broadcast = (payload: unknown) => void;

/** Durable persistence for the hub's ui stream — an adapter over the event
 * log repository, injected by the composition root (app.ts). */
export interface UiEventStream {
  streamId: string;
  append(type: string, payload: Record<string, unknown>): StreamEntry;
  replayAfter(after: number): StreamEntry[];
  latest(): number;
  oldest(): number;
}

export interface StreamCursor {
  schemaVersion: number;
  streamId: string;
  sequence: number;
}

export interface SseHub {
  broadcast: Broadcast;
  attach(req: IncomingMessage, res: ServerResponse, lastEventId?: string | null): void;
  clientCount(): number;
  /** The current end of the durable ui stream — a snapshot taken at this
   * cursor plus a subscription from it misses nothing. */
  cursor(): StreamCursor;
}

/** Frames that are never persisted or replayed: they re-stream constantly
 * while a turn runs and coalesce into committed frames post-turn (the
 * settled message carries the full text; the transcript carries the kept
 * screenshots). Everything else is a semantic frame and is durable. */
export function isEphemeralFrame(payload: unknown): boolean {
  const frame = payload as { kind?: unknown; event?: { type?: unknown } };
  if (frame?.kind === "screen") return true;
  return frame?.kind === "runtime" && frame.event?.type === "content.delta";
}

/** In-memory fallback stream (unit tests / hubs built without a database). */
export function createMemoryUiEventStream(streamId = "ui"): UiEventStream {
  const entries: StreamEntry[] = [];
  let next = 1;
  return {
    streamId,
    append(_type, payload) {
      const entry = {
        sequence: next,
        payload: { ...payload, schemaVersion: EVENT_SCHEMA_VERSION, streamId, sequence: next },
      };
      next += 1;
      entries.push(entry);
      return entry;
    },
    replayAfter(after) {
      return entries.filter((e) => e.sequence > after);
    },
    latest() {
      return entries.length ? entries[entries.length - 1].sequence : 0;
    },
    oldest() {
      return entries.length ? entries[0].sequence : 0;
    },
  };
}

function sseFrame(payload: unknown, id?: number): string {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  return id === undefined ? data : `id: ${id}\n${data}`;
}

export function createSseHub(stream: UiEventStream = createMemoryUiEventStream()): SseHub {
  const clients = new Set<ServerResponse>();
  return {
    broadcast(payload) {
      let frame: string;
      if (isEphemeralFrame(payload)) {
        frame = sseFrame(payload);
      } else {
        try {
          const kind = String((payload as { kind?: unknown })?.kind ?? "unknown");
          const entry = stream.append(kind, payload as Record<string, unknown>);
          frame = sseFrame(entry.payload, entry.sequence);
        } catch {
          // a failed log write must never take down the live stream — the
          // frame goes out unsequenced (not replayable) instead of not at all
          frame = sseFrame(payload);
        }
      }
      for (const res of [...clients]) {
        try {
          res.write(frame);
        } catch {
          clients.delete(res);
        }
      }
    },
    attach(req, res, lastEventId) {
      // the header wins over the query param: on an auto-reconnect the
      // browser re-requests the ORIGINAL url (stale ?lastEventId=) but
      // sends the freshest received id as Last-Event-ID
      const rawHeader = req.headers["last-event-id"];
      const raw = typeof rawHeader === "string" ? rawHeader : (lastEventId ?? null);
      const requested = raw !== null && /^\d+$/.test(raw.trim()) ? Number.parseInt(raw.trim(), 10) : null;

      const latest = stream.latest();
      const oldest = stream.oldest();
      // resumable only when the full suffix after `requested` is still
      // retained AND the cursor is not from a wiped/newer stream — anything
      // else must NOT silently skip events, so the client is told to
      // snapshot instead (hello.resumed = false)
      const resumed = requested !== null && requested <= latest && (latest === 0 || requested >= oldest - 1);

      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      // the hello carries the stream identity + current cursor (no id: —
      // it is not a stream event and must not advance Last-Event-ID)
      res.write(
        sseFrame({
          kind: "hello",
          schemaVersion: EVENT_SCHEMA_VERSION,
          streamId: stream.streamId,
          sequence: latest,
          resumed,
        }),
      );
      if (resumed) {
        for (const entry of stream.replayAfter(requested!)) {
          res.write(sseFrame(entry.payload, entry.sequence));
        }
      }
      clients.add(res);
      const keepalive = setInterval(() => {
        try {
          res.write(": keepalive\n\n");
        } catch {
          /* client is gone; close handler cleans up */
        }
      }, 25_000);
      req.on("close", () => {
        clearInterval(keepalive);
        clients.delete(res);
      });
    },
    clientCount() {
      return clients.size;
    },
    cursor() {
      return { schemaVersion: EVENT_SCHEMA_VERSION, streamId: stream.streamId, sequence: stream.latest() };
    },
  };
}
