// P6 letter pins: four lanes, fairness, cancellation, observability,
// single-turn-per-bot, durable idempotency. Channel inbound never
// inherits standing approvals. startTurn is called, not rewritten.
// No sleeps — wait on lane events.
import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "../config.ts";
import { defaultDbPath, openDatabase } from "../db/database.ts";
import type { SqliteDatabase } from "../db/sqlite-native.ts";
import { createLaneIdempotencyRepository } from "../repositories/lanes.ts";
import {
  createLaneScheduler,
  SCHEDULER_LANES,
  type LaneEnqueueResult,
  type LaneScheduler,
  type SchedulerLane,
} from "./lanes.ts";

interface LaneFrame {
  kind?: string;
  workId?: string;
  lane?: string;
  botId?: string;
  status?: string;
}

function recordFrames(): {
  frames: LaneFrame[];
  broadcast: (payload: unknown) => void;
  until: (pred: (frames: LaneFrame[]) => boolean) => Promise<LaneFrame[]>;
} {
  const frames: LaneFrame[] = [];
  const waiters: Array<() => void> = [];
  const notify = () => {
    for (const w of waiters.splice(0)) w();
  };
  return {
    frames,
    broadcast(payload) {
      frames.push(payload as LaneFrame);
      notify();
    },
    until(pred) {
      if (pred(frames)) return Promise.resolve(frames);
      return new Promise((resolve, reject) => {
        const tryNow = () => {
          if (!pred(frames)) return;
          const idx = waiters.indexOf(tryNow);
          if (idx !== -1) waiters.splice(idx, 1);
          clearTimeout(timer);
          resolve(frames);
        };
        const timer = setTimeout(() => {
          const idx = waiters.indexOf(tryNow);
          if (idx !== -1) waiters.splice(idx, 1);
          reject(new Error(`no matching lane event; saw: ${frames.map((f) => `${f.lane}:${f.status}`).join(", ") || "(none)"}`));
        }, 5_000);
        timer.unref?.();
        waiters.push(tryNow);
      });
    },
  };
}

describe("lane scheduler (P6)", () => {
  let db: SqliteDatabase;
  let busy: Set<string>;
  let started: Array<{ botId: string; text: string; opts?: { unattended?: boolean } }>;
  let startWaiters: Array<() => void>;
  let interrupted: string[];
  let frames: ReturnType<typeof recordFrames>;
  let lanes: LaneScheduler;

  function notifyStarted(): void {
    for (const w of startWaiters.splice(0)) w();
  }

  function untilStarted(count: number): Promise<void> {
    if (started.length >= count) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const tryNow = () => {
        if (started.length < count) return;
        const idx = startWaiters.indexOf(tryNow);
        if (idx !== -1) startWaiters.splice(idx, 1);
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        const idx = startWaiters.indexOf(tryNow);
        if (idx !== -1) startWaiters.splice(idx, 1);
        reject(new Error(`startTurn count ${started.length} never reached ${count}`));
      }, 5_000);
      timer.unref?.();
      startWaiters.push(tryNow);
    });
  }

  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    db = openDatabase(defaultDbPath());
    busy = new Set();
    started = [];
    startWaiters = [];
    interrupted = [];
    frames = recordFrames();
    lanes = createLaneScheduler({
      keys: createLaneIdempotencyRepository(db),
      broadcast: frames.broadcast,
      now: () => 1_700_000_000_000,
      isBusy: (botId) => busy.has(botId),
      startTurn: async (botId, text, opts) => {
        busy.add(botId);
        started.push({ botId, text, opts: opts?.unattended ? { unattended: true } : {} });
        notifyStarted();
        return { threadId: `thread-${botId}`, messageId: `msg-${started.length}` };
      },
      interrupt: async (botId) => {
        interrupted.push(botId);
        busy.delete(botId);
        lanes.noteIdle(botId);
        return { ok: true };
      },
    });
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  });

  function finish(botId: string): void {
    busy.delete(botId);
    lanes.noteIdle(botId);
  }

  it("exposes the four letter lanes", () => {
    expect(SCHEDULER_LANES).toEqual(["user", "channel", "agent", "background"]);
  });

  it("starts an idle bot immediately and reports running + lane + botId", async () => {
    const accepted = await lanes.enqueue({ lane: "user", botId: "bot-a", text: "hello" });
    expect(accepted).toMatchObject({ status: "running", lane: "user", botId: "bot-a" });
    expect(accepted.started).toEqual({ threadId: "thread-bot-a", messageId: "msg-1" });
    expect(started).toEqual([{ botId: "bot-a", text: "hello", opts: {} }]);
    await frames.until((f) => f.some((e) => e.status === "queued") && f.some((e) => e.status === "running"));
    const snap = lanes.snapshot();
    expect(snap.running).toEqual([
      expect.objectContaining({ workId: accepted.workId, lane: "user", botId: "bot-a", status: "running" }),
    ]);
    expect(snap.queued).toEqual([]);
  });

  it("keeps a single running turn per bot and queues the rest", async () => {
    const first = await lanes.enqueue({ lane: "user", botId: "bot-a", text: "one" });
    const second = await lanes.enqueue({ lane: "channel", botId: "bot-a", text: "two" });
    expect(first.status).toBe("running");
    expect(second.status).toBe("queued");
    expect(started).toHaveLength(1);
    expect(lanes.snapshot().queued).toEqual([
      expect.objectContaining({ workId: second.workId, lane: "channel", botId: "bot-a", status: "queued" }),
    ]);
    expect(lanes.snapshot().running).toHaveLength(1);
  });

  it("lets two bots run at once (per-bot cap, not global)", async () => {
    const a = await lanes.enqueue({ lane: "user", botId: "bot-a", text: "a" });
    const b = await lanes.enqueue({ lane: "background", botId: "bot-b", text: "b" });
    expect(a.status).toBe("running");
    expect(b.status).toBe("running");
    expect(started.map((s) => s.botId).sort()).toEqual(["bot-a", "bot-b"]);
  });

  it("round-robins lanes so a flood of one lane cannot starve another", async () => {
    busy.add("bot-a");
    const order: SchedulerLane[] = [];
    const queued: LaneEnqueueResult[] = [];
    for (const text of ["u1", "u2", "u3"]) {
      queued.push(await lanes.enqueue({ lane: "user", botId: "bot-a", text }));
    }
    queued.push(await lanes.enqueue({ lane: "background", botId: "bot-a", text: "bg" }));
    expect(queued.every((q) => q.status === "queued")).toBe(true);
    expect(started).toEqual([]);

    const originalStart = started;
    // wrap by replacing startTurn via a fresh scheduler is heavier; observe
    // the existing startTurn pushes. Finish the hold, then each running turn.
    busy.delete("bot-a");
    lanes.noteIdle("bot-a");
    await untilStarted(1);
    order.push("user");
    expect(started[0]?.text).toBe("u1");

    finish("bot-a");
    await untilStarted(2);
    expect(started[1]?.text).toBe("bg");
    order.push("background");

    finish("bot-a");
    await untilStarted(3);
    expect(started[2]?.text).toBe("u2");
    finish("bot-a");
    await untilStarted(4);
    expect(started[3]?.text).toBe("u3");
    expect(order).toEqual(["user", "background"]);
    expect(originalStart.map((s) => s.text)).toEqual(["u1", "bg", "u2", "u3"]);
  });

  it("cancels queued work so it never reaches startTurn", async () => {
    const running = await lanes.enqueue({ lane: "user", botId: "bot-a", text: "running" });
    const queued = await lanes.enqueue({ lane: "agent", botId: "bot-a", text: "later" });
    const cancelled = await lanes.cancel({ workId: queued.workId });
    expect(cancelled.cancelled).toEqual([
      expect.objectContaining({ workId: queued.workId, lane: "agent", botId: "bot-a", status: "cancelled" }),
    ]);
    expect(started).toHaveLength(1);
    finish("bot-a");
    await running.settled;
    expect(started).toHaveLength(1);
    expect(lanes.snapshot().cancelled).toEqual([
      expect.objectContaining({ workId: queued.workId, lane: "agent", status: "cancelled" }),
    ]);
    await frames.until((f) => f.some((e) => e.workId === queued.workId && e.status === "cancelled"));
  });

  it("cancels a running turn through the existing interrupt path", async () => {
    const running = await lanes.enqueue({ lane: "user", botId: "bot-a", text: "now" });
    const cancelled = await lanes.cancel({ workId: running.workId });
    expect(interrupted).toEqual(["bot-a"]);
    expect(cancelled.cancelled).toEqual([
      expect.objectContaining({ workId: running.workId, lane: "user", botId: "bot-a", status: "cancelled" }),
    ]);
    expect(lanes.snapshot().running).toEqual([]);
    await frames.until((f) => f.some((e) => e.workId === running.workId && e.status === "cancelled"));
  });

  it("snapshot lists queued, running, and cancelled with lane + botId", async () => {
    const running = await lanes.enqueue({ lane: "user", botId: "bot-a", text: "run" });
    const queued = await lanes.enqueue({ lane: "channel", botId: "bot-a", text: "wait" });
    await lanes.cancel({ workId: queued.workId });
    const snap = lanes.snapshot();
    expect(snap.running).toEqual([
      expect.objectContaining({ workId: running.workId, lane: "user", botId: "bot-a", status: "running" }),
    ]);
    expect(snap.queued).toEqual([]);
    expect(snap.cancelled).toEqual([
      expect.objectContaining({ workId: queued.workId, lane: "channel", botId: "bot-a", status: "cancelled" }),
    ]);
  });

  it("durable keys: a retried inbound/routine fire does not start a second turn", async () => {
    const first = await lanes.enqueue({
      lane: "channel",
      botId: "bot-a",
      text: "ping",
      idempotencyKey: "channel:discord:msg-9",
    });
    expect(first.status).toBe("running");
    const retry = await lanes.enqueue({
      lane: "channel",
      botId: "bot-a",
      text: "ping again",
      idempotencyKey: "channel:discord:msg-9",
    });
    expect(retry).toMatchObject({ status: "duplicate", workId: first.workId, lane: "channel", botId: "bot-a" });
    expect(started).toHaveLength(1);

    finish("bot-a");
    db.close();
    db = openDatabase(defaultDbPath());
    const restarted = createLaneScheduler({
      keys: createLaneIdempotencyRepository(db),
      broadcast: () => {},
      isBusy: () => false,
      startTurn: async (botId, text) => {
        started.push({ botId, text, opts: {} });
        return { threadId: "t", messageId: "m" };
      },
      interrupt: async () => ({ ok: true }),
    });
    const afterRestart = await restarted.enqueue({
      lane: "channel",
      botId: "bot-a",
      text: "ping again",
      idempotencyKey: "channel:discord:msg-9",
    });
    expect(afterRestart.status).toBe("duplicate");
    expect(started).toHaveLength(1);
  });

  it("forces unattended on the channel lane and strips it from the user lane", async () => {
    await lanes.enqueue({ lane: "channel", botId: "bot-a", text: "from discord" });
    expect(started[0]?.opts).toEqual({ unattended: true });
    finish("bot-a");
    await lanes.enqueue({ lane: "user", botId: "bot-b", text: "typed", opts: { unattended: true } });
    expect(started[1]?.opts).toEqual({});
  });

  it("background lane keeps caller unattended (routines / listeners)", async () => {
    await lanes.enqueue({
      lane: "background",
      botId: "bot-a",
      text: "routine",
      opts: { unattended: true, systemNote: "fence" },
    });
    expect(started[0]).toMatchObject({ text: "routine", opts: { unattended: true } });
  });
});
