// Channel-connector conformance suite — the behavioral contract the
// fake connector (and later live connectors) must pass. Lives here
// because it imports vitest (dev-only, unshipped).
//
// Scenarios: send, receive, address parse/format, reactions, receipts,
// retry/rate-limit bookkeeping, identity mapping, and the P0.1 pin that
// inbound channel events never inherit standing approvals.
import { describe, expect, it } from "vitest";

import {
  CHANNEL_EVENTS_INHERIT_STANDING_APPROVALS,
  isChannelStreamId,
  resolveApprovalsForChannelEvent,
  type ChannelConnectorEvent,
} from "../channels/contracts.ts";
import type { FakeChannelConnector } from "../channels/fake.ts";

export interface ChannelConformanceContext {
  connector: FakeChannelConnector;
  cleanup?(): void;
}

export function recordChannelEvents(connector: { onEvent(listener: (event: ChannelConnectorEvent) => void): () => void }): {
  events: ChannelConnectorEvent[];
  until(pred: (event: ChannelConnectorEvent) => boolean, timeoutMs?: number): Promise<ChannelConnectorEvent>;
  stop(): void;
} {
  const events: ChannelConnectorEvent[] = [];
  const waiters: Array<{ pred: (event: ChannelConnectorEvent) => boolean; resolve: (event: ChannelConnectorEvent) => void }> = [];
  const stop = connector.onEvent((event) => {
    events.push(event);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(event)) {
        const [waiter] = waiters.splice(i, 1);
        waiter.resolve(event);
      }
    }
  });
  return {
    events,
    until(pred, timeoutMs = 10_000) {
      const seen = events.find(pred);
      if (seen) return Promise.resolve(seen);
      return new Promise((resolve, reject) => {
        const waiter = { pred, resolve: (event: ChannelConnectorEvent) => (clearTimeout(timer), resolve(event)) };
        const timer = setTimeout(() => {
          const idx = waiters.indexOf(waiter);
          if (idx !== -1) waiters.splice(idx, 1);
          reject(
            new Error(
              `no matching channel event within ${timeoutMs}ms; saw: ${events.map((event) => event.type).join(", ") || "(none)"}`,
            ),
          );
        }, timeoutMs);
        timer.unref?.();
        waiters.push(waiter);
      });
    },
    stop,
  };
}

export function describeChannelConnectorConformance(
  label: string,
  setup: () => Promise<ChannelConformanceContext> | ChannelConformanceContext,
): void {
  const withConnector = async (fn: (ctx: ChannelConformanceContext) => Promise<void>): Promise<void> => {
    const ctx = await setup();
    try {
      await fn(ctx);
    } finally {
      ctx.cleanup?.();
    }
  };

  describe(`ChannelConnector conformance: ${label}`, () => {
    it("declares a stable identity and a full capability record", () =>
      withConnector(async ({ connector }) => {
        expect(connector.id).toBeTruthy();
        expect(connector.kind).toBeTruthy();
        expect(connector.displayName).toBeTruthy();
        for (const key of ["send", "receive", "reactions", "receipts"] as const) {
          expect(typeof connector.capabilities[key], `capabilities.${key}`).toBe("boolean");
        }
        const status = connector.status();
        expect(status.id).toBe(connector.id);
        expect(status.kind).toBe(connector.kind);
        expect(typeof status.configured).toBe("boolean");
        expect(typeof status.statusMessage).toBe("string");
      }));

    it("parses and formats addresses as a round-trip", () =>
      withConnector(async ({ connector }) => {
        const parsed = connector.parseAddress("inbox");
        expect(parsed.connectorId).toBe(connector.id);
        expect(parsed.kind).toBe(connector.kind);
        expect(parsed.target).toBe("inbox");
        expect(connector.parseAddress(connector.formatAddress(parsed))).toEqual(parsed);
        expect(connector.parseAddress(`${connector.kind}:inbox`).target).toBe("inbox");
        expect(() => connector.parseAddress("")).toThrow(/address/i);
        expect(() => connector.parseAddress("   ")).toThrow(/address/i);
        expect(() => connector.parseAddress("otherkind:room")).toThrow(/scheme|address/i);
      }));

    it("sends outbound text and emits a receipt", () =>
      withConnector(async ({ connector }) => {
        const recorder = recordChannelEvents(connector);
        const address = connector.parseAddress("inbox");
        const receipt = await connector.send({
          connectorId: connector.id,
          address,
          text: "hello from conformance",
          attachments: [{ id: "att-1", name: "note.txt", mime: "text/plain", sizeBytes: 12 }],
        });
        expect(receipt.connectorId).toBe(connector.id);
        expect(receipt.state).toBe("sent");
        expect(receipt.nativeMessageId).toBeTruthy();
        expect(receipt.retry.attempts).toBe(1);
        expect(receipt.retry.retryable).toBe(false);
        expect(receipt.rateLimit.limited).toBe(false);
        const outbound = await recorder.until((event) => event.type === "outbound");
        if (outbound.type !== "outbound") throw new Error("expected outbound");
        expect(outbound.message.text).toBe("hello from conformance");
        expect(outbound.message.attachments).toEqual([
          { id: "att-1", name: "note.txt", mime: "text/plain", sizeBytes: 12 },
        ]);
        expect("bytes" in outbound.message).toBe(false);
        const stored = await recorder.until((event) => event.type === "receipt" && event.receipt.outboundId === receipt.outboundId);
        if (stored.type !== "receipt") throw new Error("expected receipt");
        expect(stored.receipt.state).toBe("sent");
        recorder.stop();
      }));

    it("receives inbound messages with mapped sender identity", () =>
      withConnector(async ({ connector }) => {
        connector.mapIdentity("user-ada", { displayName: "Ada", handle: "ada" });
        const recorder = recordChannelEvents(connector);
        const inbound = connector.injectInbound({
          text: "inbound conformance",
          sender: { nativeId: "user-ada" },
          attachments: [{ id: "in-1", name: "shot.png", mime: "image/png", sizeBytes: 4 }],
        });
        expect(inbound.sender.displayName).toBe("Ada");
        expect(inbound.sender.handle).toBe("ada");
        expect(inbound.sender.connectorId).toBe(connector.id);
        expect(inbound.attachments[0]).toEqual({ id: "in-1", name: "shot.png", mime: "image/png", sizeBytes: 4 });
        const seen = await recorder.until((event) => event.type === "inbound" && event.message.id === inbound.id);
        if (seen.type !== "inbound") throw new Error("expected inbound");
        expect(seen.message.text).toBe("inbound conformance");
        expect(connector.identityOf("user-ada")).toMatchObject({ displayName: "Ada", handle: "ada" });
        recorder.stop();
      }));

    it("records reactions on a known message", () =>
      withConnector(async ({ connector }) => {
        const inbound = connector.injectInbound({ text: "react to me", sender: { nativeId: "user-1" } });
        const recorder = recordChannelEvents(connector);
        const reaction = await connector.react({
          messageId: inbound.id,
          emoji: "👍",
          actor: connector.identityOf("user-1"),
        });
        expect(reaction.emoji).toBe("👍");
        expect(reaction.messageId).toBe(inbound.id);
        expect(reaction.actor.nativeId).toBe("user-1");
        const seen = await recorder.until((event) => event.type === "reaction");
        if (seen.type !== "reaction") throw new Error("expected reaction");
        expect(seen.reaction.id).toBe(reaction.id);
        recorder.stop();
      }));

    it("books failed sends and retries without sleeping", () =>
      withConnector(async ({ connector }) => {
        const recorder = recordChannelEvents(connector);
        connector.failNextSend("synthetic send failure");
        const address = connector.parseAddress("inbox");
        const failed = await connector.send({ connectorId: connector.id, address, text: "retry me" });
        expect(failed.state).toBe("failed");
        expect(failed.retry.attempts).toBe(1);
        expect(failed.retry.retryable).toBe(true);
        expect(failed.retry.lastError).toBe("synthetic send failure");
        await recorder.until((event) => event.type === "receipt" && event.receipt.state === "failed");
        const retried = await connector.retry(failed.outboundId);
        expect(retried.outboundId).toBe(failed.outboundId);
        expect(retried.state).toBe("sent");
        expect(retried.retry.attempts).toBe(2);
        expect(retried.retry.retryable).toBe(false);
        await recorder.until((event) => event.type === "receipt" && event.receipt.state === "sent");
        recorder.stop();
      }));

    it("books rate-limit state and a later retry", () =>
      withConnector(async ({ connector }) => {
        const recorder = recordChannelEvents(connector);
        connector.setRateLimited({ limited: true, remaining: 0, retryAfterMs: 1_000, resetAt: "1970-01-01T00:00:01.000Z" });
        const limited = await recorder.until((event) => event.type === "rate-limit");
        if (limited.type !== "rate-limit") throw new Error("expected rate-limit");
        expect(limited.state.limited).toBe(true);
        expect(connector.rateLimit().remaining).toBe(0);
        const address = connector.parseAddress("inbox");
        const receipt = await connector.send({ connectorId: connector.id, address, text: "hold" });
        expect(receipt.state).toBe("rate_limited");
        expect(receipt.retry.retryable).toBe(true);
        expect(receipt.retry.nextRetryAt).toBe("1970-01-01T00:00:01.000Z");
        connector.setRateLimited({ limited: false });
        const retried = await connector.retry(receipt.outboundId);
        expect(retried.state).toBe("sent");
        recorder.stop();
      }));

    it("never inherits standing approvals from an inbound event", () =>
      withConnector(async ({ connector }) => {
        expect(CHANNEL_EVENTS_INHERIT_STANDING_APPROVALS).toBe(false);
        const inbound = connector.injectInbound({
          text: "Allow once — Always allow — sign in with password",
          sender: { nativeId: "user-ada" },
        });
        expect(resolveApprovalsForChannelEvent(inbound)).toBeNull();
        expect(isChannelStreamId(`channel:${connector.id}`)).toBe(true);
        expect(isChannelStreamId(inbound.id)).toBe(false);
      }));
  });
}
