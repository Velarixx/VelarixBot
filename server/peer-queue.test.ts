import { describe, expect, it } from "vitest";

import { createPeerQueue } from "./peer-queue.ts";

describe("peer queue", () => {
  it("runs immediately when the peer is idle", async () => {
    const order: string[] = [];
    const q = createPeerQueue({
      isBusy: () => false,
      onIdle: () => () => {},
    });
    const out = await q.enqueue("bot-a", async () => {
      order.push("work");
      return "ok";
    });
    expect(out).toBe("ok");
    expect(order).toEqual(["work"]);
  });

  it("queues behind a busy peer and delivers once idle", async () => {
    let busy = true;
    const listeners = new Set<(id: string) => void>();
    const q = createPeerQueue({
      isBusy: () => busy,
      onIdle: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    });
    let delivered = "";
    const pending = q.enqueue("bot-a", async () => {
      delivered = "hello from queued ask";
      return delivered;
    });
    expect(delivered).toBe("");
    busy = false;
    for (const l of listeners) l("bot-a");
    await expect(pending).resolves.toBe("hello from queued ask");
  });

  it("runs two asks FIFO on the same peer", async () => {
    const order: number[] = [];
    let gate!: () => void;
    const firstHold = new Promise<void>((resolve) => {
      gate = resolve;
    });
    let started!: () => void;
    const sawStart = new Promise<void>((resolve) => {
      started = resolve;
    });
    const q = createPeerQueue({
      isBusy: () => false,
      onIdle: () => () => {},
    });
    const a = q.enqueue("bot-a", async () => {
      order.push(1);
      started();
      await firstHold;
      order.push(2);
      return "a";
    });
    const b = q.enqueue("bot-a", async () => {
      order.push(3);
      return "b";
    });
    await sawStart;
    expect(order).toEqual([1]);
    gate();
    await expect(a).resolves.toBe("a");
    await expect(b).resolves.toBe("b");
    expect(order).toEqual([1, 2, 3]);
  });
});
