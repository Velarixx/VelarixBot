import { describe, expect, it } from "vitest";
import {
  cancelPrompt,
  enqueuePrompt,
  nextFlushBotIds,
  shouldEnqueueSend,
  takeNext,
  type QueuedPrompt,
} from "./prompt-queue";

const a: QueuedPrompt = { id: "q-a", text: "first", attachments: [] };
const b: QueuedPrompt = { id: "q-b", text: "second", attachments: [{ path: "/tmp/n.md" }] };

describe("shouldEnqueueSend", () => {
  it("queues while the bot is busy or a POST is already in flight", () => {
    expect(shouldEnqueueSend(false)).toBe(false);
    expect(shouldEnqueueSend(true)).toBe(true);
    expect(shouldEnqueueSend(false, true)).toBe(true);
  });
});

describe("prompt queue helpers", () => {
  it("keeps FIFO order and can cancel before takeNext", () => {
    const queue = enqueuePrompt(enqueuePrompt([], a), b);
    expect(takeNext(queue)).toEqual({ next: a, rest: [b] });
    expect(takeNext(cancelPrompt(queue, "q-a"))).toEqual({ next: b, rest: [] });
  });

  it("selects idle bots with a queued head for flushQueue", () => {
    const bots = [
      { id: "busy", busy: true },
      { id: "idle", busy: false },
      { id: "empty", busy: false },
    ];
    const queued = {
      busy: [a],
      idle: [b],
    };
    expect(nextFlushBotIds(bots, queued)).toEqual(["idle"]);
  });
});
