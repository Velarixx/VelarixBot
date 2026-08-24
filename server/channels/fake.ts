// In-process fake channel connector. Zero network. Powers the connector
// conformance suite and service tests. Not registered at boot — tests
// construct it (or load kind "fake" through the registry).
import { newId } from "../contracts.ts";
import {
  emptyRateLimit,
  type ChannelAddress,
  type ChannelAttachmentMeta,
  type ChannelConnector,
  type ChannelConnectorFactory,
  type ChannelDeliveryReceipt,
  type ChannelEventListener,
  type ChannelIdentity,
  type ChannelInboundMessage,
  type ChannelOutboundMessage,
  type ChannelRateLimitState,
  type ChannelReaction,
  type ChannelRetryState,
} from "./contracts.ts";

export const FAKE_CHANNEL_KIND = "fake";

export interface FakeChannelConfig {
  /** Optional seed identities keyed by native id. */
  identities?: Record<string, { displayName?: string; handle?: string; bot?: boolean }>;
  maxAttempts?: number;
}

export interface FakeChannelClock {
  now(): number;
}

export interface FakeChannelConnector extends ChannelConnector {
  /** Test-only: deliver an inbound message as the channel would. */
  injectInbound(
    input: {
      text: string;
      address?: ChannelAddress;
      sender?: Partial<ChannelIdentity> & { nativeId?: string };
      attachments?: ChannelAttachmentMeta[];
      replyToId?: string;
      id?: string;
    },
  ): ChannelInboundMessage;
  mapIdentity(nativeId: string, identity: { displayName?: string; handle?: string; bot?: boolean }): void;
  identityOf(nativeId: string): ChannelIdentity;
  setRateLimited(state: Partial<ChannelRateLimitState>): void;
  failNextSend(error: string): void;
  storedOutbound(outboundId: string): ChannelOutboundMessage | undefined;
  storedInbound(messageId: string): ChannelInboundMessage | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function decodeFakeChannelConfig(raw: unknown): FakeChannelConfig {
  if (raw === undefined) return {};
  if (!isRecord(raw)) throw new Error("fake channel: config must be an object");
  const config: FakeChannelConfig = {};
  if (raw.identities !== undefined) {
    if (!isRecord(raw.identities)) throw new Error("fake channel: identities must be an object");
    const identities: NonNullable<FakeChannelConfig["identities"]> = {};
    for (const [nativeId, entry] of Object.entries(raw.identities)) {
      if (!nativeId.trim()) throw new Error("fake channel: identity native id must be non-empty");
      if (!isRecord(entry)) throw new Error("fake channel: each identity must be an object");
      identities[nativeId] = {
        ...(typeof entry.displayName === "string" ? { displayName: entry.displayName } : {}),
        ...(typeof entry.handle === "string" ? { handle: entry.handle } : {}),
        ...(entry.bot === true ? { bot: true } : {}),
      };
    }
    config.identities = identities;
  }
  if (raw.maxAttempts !== undefined) {
    if (typeof raw.maxAttempts !== "number" || !Number.isInteger(raw.maxAttempts) || raw.maxAttempts < 1) {
      throw new Error("fake channel: maxAttempts must be a positive integer");
    }
    config.maxAttempts = raw.maxAttempts;
  }
  return config;
}

export function parseFakeAddress(raw: string, connectorId: string): ChannelAddress {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("fake channel: address must be non-empty");
  let target = trimmed;
  if (trimmed.startsWith("fake://")) target = trimmed.slice("fake://".length);
  else if (trimmed.startsWith("fake:")) target = trimmed.slice("fake:".length);
  else if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
    throw new Error(`fake channel: unsupported address scheme in "${trimmed}"`);
  }
  target = target.replace(/^\/+/, "").trim();
  if (!target || /\s/.test(target)) throw new Error("fake channel: address target must be a single token");
  return { connectorId, kind: FAKE_CHANNEL_KIND, target, display: `fake:${target}` };
}

export function formatFakeAddress(address: ChannelAddress): string {
  if (address.kind !== FAKE_CHANNEL_KIND) {
    throw new Error(`fake channel: cannot format a ${address.kind} address`);
  }
  if (!address.target.trim()) throw new Error("fake channel: address target must be non-empty");
  return `fake:${address.target.trim()}`;
}

function iso(now: number): string {
  return new Date(now).toISOString();
}

export function createFakeChannelConnector(
  input: { id: string; config?: FakeChannelConfig; clock?: FakeChannelClock },
): FakeChannelConnector {
  const connectorId = input.id;
  const maxAttempts = input.config?.maxAttempts ?? 3;
  const clock: FakeChannelClock = input.clock ?? { now: () => Date.now() };
  const listeners = new Set<ChannelEventListener>();
  const identities = new Map<string, { displayName?: string; handle?: string; bot?: boolean }>(
    Object.entries(input.config?.identities ?? {}),
  );
  const inbound = new Map<string, ChannelInboundMessage>();
  const outbound = new Map<string, { message: ChannelOutboundMessage; receipt: ChannelDeliveryReceipt }>();
  const reactions = new Map<string, ChannelReaction>();
  let rateLimit: ChannelRateLimitState = emptyRateLimit();
  let nextFailure: string | null = null;

  function emit(event: Parameters<ChannelEventListener>[0]): void {
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch (error) {
        console.error("fake channel: listener threw", error);
      }
    }
  }

  function identityOf(nativeId: string): ChannelIdentity {
    const mapped = identities.get(nativeId);
    return {
      connectorId,
      nativeId,
      displayName: mapped?.displayName ?? `Fake ${nativeId}`,
      ...(mapped?.handle ? { handle: mapped.handle } : { handle: nativeId }),
      ...(mapped?.bot === true ? { bot: true } : {}),
    };
  }

  function defaultAddress(): ChannelAddress {
    return { connectorId, kind: FAKE_CHANNEL_KIND, target: "inbox", display: "fake:inbox" };
  }

  function receiptFor(
    outboundId: string,
    state: ChannelDeliveryReceipt["state"],
    retry: ChannelRetryState,
    extra: Partial<ChannelDeliveryReceipt> = {},
  ): ChannelDeliveryReceipt {
    return {
      outboundId,
      connectorId,
      state,
      retry,
      rateLimit: { ...rateLimit },
      at: iso(clock.now()),
      ...extra,
    };
  }

  async function deliver(
    outboundId: string,
    message: ChannelOutboundMessage,
    prior?: ChannelRetryState,
  ): Promise<ChannelDeliveryReceipt> {
    const attempts = (prior?.attempts ?? 0) + 1;
    const retry: ChannelRetryState = {
      attempts,
      maxAttempts,
      retryable: attempts < maxAttempts,
      ...(prior?.lastError ? { lastError: prior.lastError } : {}),
    };

    if (rateLimit.limited) {
      retry.retryable = true;
      retry.lastError = "rate limited";
      if (rateLimit.resetAt) retry.nextRetryAt = rateLimit.resetAt;
      const receipt = receiptFor(outboundId, "rate_limited", retry, { error: "rate limited" });
      outbound.set(outboundId, { message, receipt });
      emit({ type: "receipt", receipt });
      return receipt;
    }

    if (nextFailure) {
      const error = nextFailure;
      nextFailure = null;
      retry.lastError = error;
      retry.retryable = attempts < maxAttempts;
      const receipt = receiptFor(outboundId, "failed", retry, { error });
      outbound.set(outboundId, { message, receipt });
      emit({ type: "receipt", receipt });
      return receipt;
    }

    const nativeMessageId = `fake-msg-${outboundId}`;
    const receipt = receiptFor(outboundId, "sent", { ...retry, retryable: false }, { nativeMessageId });
    outbound.set(outboundId, { message, receipt });
    emit({ type: "outbound", outboundId, message });
    emit({ type: "receipt", receipt });
    return receipt;
  }

  const connector: FakeChannelConnector = {
    id: connectorId,
    kind: FAKE_CHANNEL_KIND,
    displayName: "Fake channel",
    capabilities: { send: true, receive: true, reactions: true, receipts: true },

    status() {
      return {
        id: connectorId,
        kind: FAKE_CHANNEL_KIND,
        displayName: "Fake channel",
        configured: true,
        enabled: true,
        status: "connected",
        statusMessage: "Fake channel is in-process and does not use the network.",
      };
    },

    parseAddress(raw) {
      return parseFakeAddress(raw, connectorId);
    },

    formatAddress(address) {
      return formatFakeAddress(address);
    },

    async send(message) {
      if (message.connectorId !== connectorId) {
        throw new Error("fake channel: outbound connectorId does not match this connector");
      }
      if (message.address.kind !== FAKE_CHANNEL_KIND || message.address.connectorId !== connectorId) {
        throw new Error("fake channel: outbound address is not a fake address for this connector");
      }
      const outboundId = newId();
      return deliver(outboundId, message);
    },

    async react(input) {
      if (!inbound.has(input.messageId) && ![...outbound.values()].some((row) => row.receipt.nativeMessageId === input.messageId || row.receipt.outboundId === input.messageId)) {
        throw new Error("fake channel: unknown message for reaction");
      }
      const emoji = input.emoji.trim();
      if (!emoji) throw new Error("fake channel: reaction emoji must be non-empty");
      const actor = input.actor
        ? { ...identityOf(input.actor.nativeId), ...input.actor, connectorId }
        : identityOf("bot");
      const reaction: ChannelReaction = {
        id: newId(),
        connectorId,
        messageId: input.messageId,
        emoji,
        actor,
        createdAt: iso(clock.now()),
      };
      reactions.set(reaction.id, reaction);
      emit({ type: "reaction", reaction });
      return reaction;
    },

    async retry(outboundId) {
      const row = outbound.get(outboundId);
      if (!row) throw new Error("fake channel: unknown outbound id");
      if (row.receipt.state === "sent" || row.receipt.state === "delivered") {
        return row.receipt;
      }
      if (!row.receipt.retry.retryable) {
        return row.receipt;
      }
      return deliver(outboundId, row.message, row.receipt.retry);
    },

    rateLimit() {
      return { ...rateLimit };
    },

    onEvent(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    injectInbound(input) {
      const senderNative = input.sender?.nativeId?.trim() || "user-1";
      const mapped = identityOf(senderNative);
      const sender: ChannelIdentity = {
        ...mapped,
        ...input.sender,
        connectorId,
        nativeId: senderNative,
      };
      const message: ChannelInboundMessage = {
        id: input.id ?? newId(),
        connectorId,
        address: input.address ?? defaultAddress(),
        sender,
        text: input.text,
        attachments: input.attachments ?? [],
        createdAt: iso(clock.now()),
        ...(input.replyToId ? { replyToId: input.replyToId } : {}),
      };
      inbound.set(message.id, message);
      emit({ type: "inbound", message });
      return message;
    },

    mapIdentity(nativeId, identity) {
      identities.set(nativeId, identity);
    },

    identityOf,

    setRateLimited(state) {
      rateLimit = {
        limited: state.limited ?? true,
        ...(state.remaining !== undefined ? { remaining: state.remaining } : {}),
        ...(state.resetAt ? { resetAt: state.resetAt } : {}),
        ...(state.retryAfterMs !== undefined ? { retryAfterMs: state.retryAfterMs } : {}),
      };
      emit({ type: "rate-limit", state: { ...rateLimit } });
    },

    failNextSend(error) {
      nextFailure = error;
    },

    storedOutbound(outboundId) {
      return outbound.get(outboundId)?.message;
    },

    storedInbound(messageId) {
      return inbound.get(messageId);
    },
  };

  return connector;
}

export const FakeChannelFactory: ChannelConnectorFactory<FakeChannelConfig> = {
  kind: FAKE_CHANNEL_KIND,
  metadata: { displayName: "Fake channel" },
  decodeConfig: decodeFakeChannelConfig,
  async create({ id, config }) {
    return createFakeChannelConnector({ id, config });
  },
};
