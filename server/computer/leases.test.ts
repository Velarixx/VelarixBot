// Lease broker contract (3.4/D3): FIFO, loud timeout with the holder's
// name, release-on-abort, and the suspend guard's busyFor. Event-driven —
// the only timers are the broker's own timeout windows.
import { describe, expect, it } from "vitest";

import { createLeaseBroker, LEASE_WAIT_DEFAULT_MS, leaseBusyError } from "./leases.ts";

const ada = { id: "bot-a", name: "Ada" };
const bea = { id: "bot-b", name: "Bea" };
const cyd = { id: "bot-c", name: "Cyd" };
const KEY = "box:box-1";

describe("machine lease broker", () => {
  it("defaults to the D3 ten-minute wait", () => {
    expect(LEASE_WAIT_DEFAULT_MS).toBe(10 * 60_000);
  });

  it("grants a free key immediately and is reentrant for the same owner", async () => {
    const broker = createLeaseBroker();
    await broker.acquire(KEY, ada);
    await broker.acquire(KEY, ada); // same owner — no self-deadlock
    expect(broker.holder(KEY)).toEqual(ada);
    expect(broker.busyFor(KEY, ada.id)).toBeNull();
  });

  it("queues FIFO and hands the lease over on release", async () => {
    const broker = createLeaseBroker();
    await broker.acquire(KEY, ada);
    const order: string[] = [];
    const b = broker.acquire(KEY, bea).then(() => order.push("bea"));
    const c = broker.acquire(KEY, cyd).then(() => order.push("cyd"));
    expect(broker.waiting(KEY)).toEqual([bea, cyd]);

    broker.release(KEY, ada.id);
    await b;
    expect(broker.holder(KEY)).toEqual(bea);
    broker.release(KEY, bea.id);
    await c;
    expect(broker.holder(KEY)).toEqual(cyd);
    expect(order).toEqual(["bea", "cyd"]);

    broker.release(KEY, cyd.id);
    expect(broker.holder(KEY)).toBeNull();
  });

  it("times out LOUD with the holding bot's name", async () => {
    const broker = createLeaseBroker();
    await broker.acquire(KEY, ada);
    await expect(broker.acquire(KEY, bea, { waitMs: 5 })).rejects.toThrow("computer busy — in use by Ada");
    expect(leaseBusyError(ada).message).toBe("computer busy — in use by Ada");
    // the timed-out waiter is gone — releasing the holder frees the key
    broker.release(KEY, ada.id);
    expect(broker.holder(KEY)).toBeNull();
  });

  it("release-on-abort: releasing a QUEUED owner rejects its pending acquire", async () => {
    const broker = createLeaseBroker();
    await broker.acquire(KEY, ada);
    const pending = broker.acquire(KEY, bea, { waitMs: 60_000 });
    broker.release(KEY, bea.id); // the turn was interrupted while queued
    await expect(pending).rejects.toThrow(/aborted/);
    expect(broker.waiting(KEY)).toEqual([]);
    // ada still holds; a later release hands to nobody and clears the key
    broker.release(KEY, ada.id);
    expect(broker.holder(KEY)).toBeNull();
  });

  it("busyFor reports the OTHER holder or queuer — the suspend guard", async () => {
    const broker = createLeaseBroker();
    await broker.acquire(KEY, ada);
    expect(broker.busyFor(KEY, bea.id)).toEqual(ada);
    const pending = broker.acquire(KEY, bea, { waitMs: 60_000 });
    expect(broker.busyFor(KEY, ada.id)).toEqual(bea); // someone is waiting on me
    broker.release(KEY, bea.id);
    await expect(pending).rejects.toThrow(/aborted/);
    expect(broker.busyFor(KEY, ada.id)).toBeNull();
    expect(broker.busyFor("box:other", ada.id)).toBeNull();
  });

  it("release is idempotent and ignores strangers", async () => {
    const broker = createLeaseBroker();
    await broker.acquire(KEY, ada);
    broker.release(KEY, "nobody");
    expect(broker.holder(KEY)).toEqual(ada);
    broker.release(KEY, ada.id);
    broker.release(KEY, ada.id);
    expect(broker.holder(KEY)).toBeNull();
  });

  it("keys are independent — per-bot machines never contend", async () => {
    const broker = createLeaseBroker();
    await broker.acquire("box:box-1", ada);
    await broker.acquire("box:box-2", bea); // resolves immediately
    expect(broker.holder("box:box-1")).toEqual(ada);
    expect(broker.holder("box:box-2")).toEqual(bea);
  });
});
