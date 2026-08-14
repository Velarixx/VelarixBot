// P1.3 acceptance, end to end against the real server (fake ACP driver, no
// live agents):
//   1. a renderer reload replays losslessly — snapshot + resume from the
//      snapshot's cursor reconstructs exactly the server's transcript;
//   2. dedupe — reconnect/replay never double-applies (no frame at or
//      before the resume cursor is resent, and the fold stays id-unique);
//   3. a forced disconnect + Last-Event-ID replay has zero loss and zero
//      dupes (the replayed sequences are exactly the gap, contiguous).
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { bootHarness, connectSse, FAKE_ACP_CLI, type BootedHarness, type SseFrame, type SseRecorder } from "./testing/harness.ts";

let h: BootedHarness;

const turnDone = (threadId: string) => (f: SseFrame) =>
  f.kind === "runtime" && f.event?.type === "turn.completed" && f.event.threadId === threadId;

/** Stream events only — the hello frame carries a cursor but no sseId. */
const seqs = (r: SseRecorder) => r.frames.filter((f) => f.kind !== "hello" && typeof f.sequence === "number").map((f) => f.sequence!);

async function addBot(name: string) {
  const created = await h.api("POST", "/api/bots");
  expect(created.status).toBe(201);
  const patched = await h.api("PATCH", `/api/bots/${created.body.bot.id}`, {
    name,
    modelSelection: { instanceId: "grok", model: "fake-model" },
    computer: "off",
  });
  return patched.body.bot as { id: string; threadId: string };
}

/** The renderer's message fold: snapshot messages + message/message.patch
 * frames, id-unique exactly like src/state/store.tsx applies them. */
function foldMessages(snapshot: Array<{ id: string }>, frames: SseFrame[], threadId: string): Array<{ id: string }> {
  const messages = [...snapshot];
  for (const frame of frames) {
    if (frame.threadId !== threadId || !frame.message) continue;
    const message = frame.message as { id?: string };
    if (frame.kind === "message" && !messages.some((m) => m.id === message.id)) {
      messages.push(message as { id: string });
    } else if (frame.kind === "message.patch") {
      const idx = messages.findIndex((m) => m.id === message.id);
      if (idx !== -1) messages[idx] = message as { id: string };
    }
  }
  return messages;
}

beforeAll(async () => {
  h = await bootHarness({
    instances: {
      grok: {
        driver: "grokAgent",
        environment: { FAKE_ACP_MODE: "happy" },
        config: { cli: FAKE_ACP_CLI, fullAuto: true },
      },
    },
  });
});

afterAll(async () => {
  await h.stop();
});

describe("P1.3 resumable SSE against the real server", () => {
  it("renderer reload replays losslessly: snapshot + resume reconstructs the transcript exactly once", async () => {
    const bot = await addBot("Reloady");

    // ── turn 1 while the "renderer" (h.sse) is connected ──
    await h.api("POST", `/api/bots/${bot.id}/messages`, { text: "first question" });
    await h.sse.until(turnDone(bot.threadId));

    // ── forced disconnect (the reload) ──
    h.sse.close();

    // an independent observer window tells us when the missed turn settled
    const observer = await connectSse(h.base, h.token);
    await h.api("POST", `/api/bots/${bot.id}/messages`, { text: "asked while reloading" });
    await observer.until(turnDone(bot.threadId));

    // ── the reloaded renderer boots: snapshot first ──
    const snap = await h.api("GET", "/api/events/snapshot");
    expect(snap.status).toBe(200);
    expect(snap.body).toMatchObject({ schemaVersion: 1, streamId: "ui" });
    expect(typeof snap.body.sequence).toBe("number");
    const snapBot = snap.body.bots.find((b: { id: string }) => b.id === bot.id);
    // the turn that ran during the reload is inside the snapshot
    expect(snapBot.messages.some((m: { text?: string }) => m.text === "asked while reloading")).toBe(true);

    // ── subscribe from the snapshot's cursor, then keep living ──
    const reloaded = await connectSse(h.base, h.token, { query: snap.body.sequence });
    expect((await reloaded.until((f) => f.kind === "hello")).resumed).toBe(true);
    await h.api("POST", `/api/bots/${bot.id}/messages`, { text: "post-reload question" });
    await reloaded.until(turnDone(bot.threadId));

    // dedupe at the transport: nothing at or before the snapshot cursor is resent
    expect(seqs(reloaded).every((s) => s > snap.body.sequence)).toBe(true);

    // lossless: snapshot + folded frames equal the server's ground truth,
    // every message exactly once (fold dedupes by id like the renderer)
    const folded = foldMessages(snapBot.messages, reloaded.frames, bot.threadId);
    const truth = (await h.api("GET", "/api/bots")).body.bots.find((b: { id: string }) => b.id === bot.id);
    expect(folded.map((m) => m.id)).toEqual(truth.messages.map((m: { id: string }) => m.id));
    expect(new Set(folded.map((m) => m.id)).size).toBe(folded.length);
    observer.close();
    reloaded.close();
  });

  it("forced disconnect + Last-Event-ID replay: the gap comes back contiguous, zero loss, zero dupes", async () => {
    const bot = await addBot("Dropsy");

    const before = await connectSse(h.base, h.token);
    await h.api("PATCH", `/api/bots/${bot.id}`, { title: "one" });
    await before.until((f) => f.kind === "bot" && f.bot?.id === bot.id && (f.bot as { title?: string }).title === "one");
    const lastSeen = before.frames.filter((f) => typeof f.sseId === "number").at(-1)!.sseId!;
    before.close(); // ── forced disconnect ──

    // missed while disconnected (the PATCH response returns after the
    // frame is persisted + broadcast — nothing here needs a sleep)
    await h.api("PATCH", `/api/bots/${bot.id}`, { title: "two" });
    await h.api("PATCH", `/api/bots/${bot.id}`, { title: "three" });

    // reconnect exactly as EventSource does: Last-Event-ID header
    const after = await connectSse(h.base, h.token, { header: lastSeen });
    expect((await after.until((f) => f.kind === "hello")).resumed).toBe(true);
    await h.api("PATCH", `/api/bots/${bot.id}`, { title: "four" });
    await after.until((f) => f.kind === "bot" && f.bot?.id === bot.id && (f.bot as { title?: string }).title === "four");

    const replayedSeqs = seqs(after);
    // zero dupes: nothing at or before the cursor
    expect(replayedSeqs.every((s) => s > lastSeen)).toBe(true);
    // zero loss: the sequences are contiguous from cursor+1 — no silent gap
    expect(replayedSeqs).toEqual(replayedSeqs.map((_, i) => lastSeen + 1 + i));
    // and the missed semantic updates arrived exactly once, in order
    const titles = after.frames.filter((f) => f.kind === "bot" && f.bot?.id === bot.id).map((f) => (f.bot as { title?: string }).title);
    expect(titles).toEqual(["two", "three", "four"]);
    after.close();
  });

  it("a cursor the stream cannot honor is refused (resumed=false), so a client snapshots instead of silently missing events", async () => {
    const stale = await connectSse(h.base, h.token, { query: 1_000_000 });
    const hello = await stale.until((f) => f.kind === "hello");
    expect(hello.resumed).toBe(false);
    expect(seqs(stale)).toEqual([]);
    stale.close();
  });
});
