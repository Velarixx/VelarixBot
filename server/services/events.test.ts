// P1.3 — the resumable SSE hub over the real SQLite-backed ui stream (the
// exact adapter shape app.ts wires). Pins the acceptance mechanics at the
// transport level: id:/Last-Event-ID replay with zero loss and zero dupes
// across a forced disconnect, delta coalescing (ephemeral frames carry no
// id and are never replayed), and the snapshot cursor contract.
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EVENT_SCHEMA_VERSION } from "../contracts.ts";
import { openDatabase } from "../db/database.ts";
import type { SqliteDatabase } from "../db/sqlite-native.ts";
import { createEventLogRepository, UI_STREAM_ID } from "../repositories/event-log.ts";
import { connectSse, type SseRecorder } from "../testing/harness.ts";
import { createSseHub, isEphemeralFrame, type SseHub, type UiEventStream } from "./events.ts";

function sqliteStream(db: SqliteDatabase): UiEventStream {
  const log = createEventLogRepository(db);
  return {
    streamId: UI_STREAM_ID,
    append: (type, payload) => log.appendToStream(UI_STREAM_ID, type, payload),
    replayAfter: (after) => log.replayAfter(UI_STREAM_ID, after),
    latest: () => log.latestSequence(UI_STREAM_ID),
    oldest: () => log.oldestSequence(UI_STREAM_ID),
  };
}

const botFrame = (name: string) => ({ kind: "bot", bot: { id: "b1", name } });
// the hello frame carries the cursor (a `sequence` field) but is not a
// stream event — every stream-level assertion filters it out
const stamped = (r: SseRecorder) => r.frames.filter((f) => f.kind !== "hello" && typeof f.sequence === "number");
const seqs = (r: SseRecorder) => stamped(r).map((f) => f.sequence);
const atSeq = (n: number) => (f: { kind?: string; sequence?: number }) => f.kind !== "hello" && f.sequence === n;

describe("resumable SSE hub (P1.3)", () => {
  let dir: string;
  let db: SqliteDatabase;
  let hub: SseHub;
  let server: Server;
  let base: string;
  let clients: SseRecorder[];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "omb-sse-hub-"));
    db = openDatabase(join(dir, "hub.db"));
    hub = createSseHub(sqliteStream(db));
    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      hub.attach(req, res, url.searchParams.get("lastEventId"));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    clients = [];
  });
  afterEach(async () => {
    for (const c of clients) c.close();
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      db.close();
    } catch {
      /* already closed */
    }
    rmSync(dir, { recursive: true, force: true });
  });

  async function connect(resume?: { header?: number; query?: number }): Promise<SseRecorder> {
    const c = await connectSse(base, undefined, resume);
    clients.push(c);
    await c.until((f) => f.kind === "hello");
    return c;
  }

  it("sends semantic frames stamped and with id:, in per-stream order", async () => {
    const c = await connect();
    hub.broadcast(botFrame("one"));
    hub.broadcast(botFrame("two"));
    await c.until(atSeq(2));
    const got = stamped(c);
    expect(got.map((f) => f.bot?.name)).toEqual(["one", "two"]);
    expect(got[0]).toMatchObject({ schemaVersion: EVENT_SCHEMA_VERSION, streamId: UI_STREAM_ID, sequence: 1, sseId: 1 });
    expect(got[1]).toMatchObject({ sequence: 2, sseId: 2 });
    expect(hub.cursor()).toEqual({ schemaVersion: EVENT_SCHEMA_VERSION, streamId: UI_STREAM_ID, sequence: 2 });
  });

  it("coalesces deltas: ephemeral frames carry no id, take no sequence, and are never replayed", async () => {
    const c = await connect();
    hub.broadcast({ kind: "runtime", event: { type: "content.delta", streamKind: "assistant_text", delta: "hel" } });
    hub.broadcast({ kind: "screen", botId: "b1", png: "AAAA" });
    hub.broadcast({ kind: "message", threadId: "t1", message: { id: "m1", text: "hello" } }); // the committed message
    await c.until((f) => f.kind === "message");

    const delta = c.frames.find((f) => f.kind === "runtime");
    const screen = c.frames.find((f) => f.kind === "screen");
    expect(delta?.sseId).toBeUndefined();
    expect(delta?.sequence).toBeUndefined();
    expect(screen?.sseId).toBeUndefined();
    // deltas consumed no sequence — the committed message is sequence 1
    expect(c.frames.find((f) => f.kind === "message")).toMatchObject({ sequence: 1, sseId: 1 });

    // resume from the beginning: only the semantic frame comes back
    const replayed = await connect({ header: 0 });
    await replayed.until((f) => f.kind === "message");
    expect(replayed.frames.filter((f) => f.kind === "runtime" || f.kind === "screen")).toEqual([]);
    expect(seqs(replayed)).toEqual([1]);
  });

  it("forced disconnect + Last-Event-ID replay: zero loss, zero dupes", async () => {
    const first = await connect({ query: 0 });
    hub.broadcast(botFrame("one"));
    hub.broadcast(botFrame("two"));
    hub.broadcast(botFrame("three"));
    await first.until(atSeq(3));
    const lastSeen = first.frames.filter((f) => typeof f.sseId === "number").at(-1)!.sseId!;
    expect(lastSeen).toBe(3);
    first.close(); // ── forced disconnect ──

    hub.broadcast(botFrame("four")); // missed while disconnected
    hub.broadcast(botFrame("five"));

    // reconnect exactly as a browser would: Last-Event-ID header
    const second = await connect({ header: lastSeen });
    expect((await second.until((f) => f.kind === "hello")).resumed).toBe(true);
    hub.broadcast(botFrame("six")); // live continues after the replay
    await second.until(atSeq(6));

    // zero loss: 4 and 5 replayed; zero dupes: nothing at or before 3 resent
    expect(seqs(second)).toEqual([4, 5, 6]);
    expect(stamped(second).map((f) => f.bot?.name)).toEqual(["four", "five", "six"]);

    // across the disconnect the client saw every event exactly once
    const all = [...seqs(first), ...seqs(second)];
    expect(all).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("resumes from ?lastEventId= for a fresh EventSource (renderer reload)", async () => {
    hub.broadcast(botFrame("one"));
    hub.broadcast(botFrame("two"));
    const cursor = hub.cursor().sequence; // what /api/events/snapshot hands the renderer
    hub.broadcast(botFrame("three")); // lands between snapshot and subscribe

    const c = await connect({ query: cursor });
    await c.until(atSeq(3));
    expect(seqs(c)).toEqual([3]); // the gap is replayed, the snapshot's contents are not
    expect(c.frames.find((f) => f.kind === "hello")).toMatchObject({ resumed: true, sequence: 3, streamId: UI_STREAM_ID });
  });

  it("replay is deterministic: two clients resuming from the same cursor see identical frames", async () => {
    hub.broadcast(botFrame("one"));
    hub.broadcast(botFrame("two"));
    hub.broadcast(botFrame("three"));
    const a = await connect({ header: 1 });
    const b = await connect({ header: 1 });
    await a.until(atSeq(3));
    await b.until(atSeq(3));
    expect(seqs(a)).toEqual([2, 3]);
    expect(seqs(b)).toEqual([2, 3]);
  });

  it("refuses to fake a resume it cannot honor (stale cursor from a wiped stream)", async () => {
    hub.broadcast(botFrame("one"));
    const c = await connect({ header: 99 }); // cursor beyond the stream's end
    const hello = c.frames.find((f) => f.kind === "hello");
    expect(hello).toMatchObject({ resumed: false, sequence: 1 });
    expect(seqs(c)).toEqual([]); // no partial replay that would look complete
  });

  it("classifies exactly the delta/screen frames as ephemeral", () => {
    expect(isEphemeralFrame({ kind: "screen", botId: "b" })).toBe(true);
    expect(isEphemeralFrame({ kind: "runtime", event: { type: "content.delta" } })).toBe(true);
    expect(isEphemeralFrame({ kind: "runtime", event: { type: "turn.completed" } })).toBe(false);
    expect(isEphemeralFrame({ kind: "message", message: {} })).toBe(false);
    expect(isEphemeralFrame({ kind: "bot", bot: {} })).toBe(false);
    expect(isEphemeralFrame({ kind: "config" })).toBe(false);
  });
});
