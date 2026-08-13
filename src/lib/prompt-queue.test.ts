import { describe, expect, it } from "vitest";
import {
  cancelPrompt,
  enqueuePrompt,
  queueAfterInterrupt,
  sendDecision,
  takeNext,
  type QueuedPrompt,
} from "./prompt-queue";

const a: QueuedPrompt = { id: "q-a", text: "first", attachments: [] };
const b: QueuedPrompt = { id: "q-b", text: "second", attachments: [{ path: "/tmp/n.md" }] };

describe("sendDecision", () => {
  it("sends immediately when idle and queues while busy", () => {
    expect(sendDecision(false)).toBe("send");
    expect(sendDecision(true)).toBe("queue");
  });
});

describe("prompt queue", () => {
  it("keeps FIFO order", () => {
    const queue = enqueuePrompt(enqueuePrompt([], a), b);
    expect(queue.map((item) => item.id)).toEqual(["q-a", "q-b"]);
    expect(takeNext(queue)).toEqual({ next: a, rest: [b] });
  });

  it("cancels an item before it is processed", () => {
    const queue = enqueuePrompt(enqueuePrompt([], a), b);
    expect(cancelPrompt(queue, "q-a")).toEqual([b]);
    expect(takeNext(cancelPrompt(queue, "q-a"))).toEqual({ next: b, rest: [] });
  });

  it("leaves the queue intact when the current turn is interrupted", () => {
    const queue = enqueuePrompt(enqueuePrompt([], a), b);
    expect(queueAfterInterrupt(queue)).toEqual(queue);
    expect(sendDecision(true)).toBe("queue");
  });
});
