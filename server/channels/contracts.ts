// Generic channel-connector SPI (Priority 1).
//
// One in-process contract every chat connector (fake today; Discord later)
// implements. Types are VelarixBot-native — addresses, inbound/outbound
// messages, attachment metadata, reactions, sender identities, delivery
// receipts, and retry/rate-limit bookkeeping.
//
// This file is contracts only. Attachment policy lives in
// server/attachments/. No live Gateway, no routine triggers, no MCP,
// no scheduler, no request lineage.
//
// P0.1 pin: external channel events NEVER inherit standing approvals.
// An inbound event does not auto-resolve Allow-once, Always-allow, an
// Advanced all-bots matcher, or a credential ask. Deny is never persisted
// from a channel event either.

export type ChannelConnectorId = string;
export type ChannelConnectorKind = string;

export const CHANNEL_STREAM_PREFIX = "channel:";

/** Durable bus/store stream for one connector — never a bot thread id. */
export function channelStreamId(connectorId: ChannelConnectorId): string {
  return `${CHANNEL_STREAM_PREFIX}${connectorId}`;
}

export function isChannelStreamId(threadId: string): boolean {
  return threadId.startsWith(CHANNEL_STREAM_PREFIX);
}

// ── addresses ──────────────────────────────────────────────────────────

export interface ChannelAddress {
  connectorId: ChannelConnectorId;
  kind: ChannelConnectorKind;
  /** Channel-native location (room, chat, or channel id). */
  target: string;
  display?: string;
}

// ── identities ─────────────────────────────────────────────────────────

export interface ChannelIdentity {
  connectorId: ChannelConnectorId;
  /** Stable id on the remote channel (user / webhook / bot snowflake). */
  nativeId: string;
  displayName?: string;
  handle?: string;
  /** True when this is the connector's own bot identity. */
  bot?: boolean;
}

// ── attachments (metadata on the wire; policy in server/attachments/) ──

export interface ChannelAttachmentMeta {
  id: string;
  name: string;
  mime?: string;
  sizeBytes?: number;
}

// ── messages ───────────────────────────────────────────────────────────

export interface ChannelInboundMessage {
  id: string;
  connectorId: ChannelConnectorId;
  address: ChannelAddress;
  sender: ChannelIdentity;
  text: string;
  attachments: ChannelAttachmentMeta[];
  createdAt: string;
  replyToId?: string;
}

export interface ChannelOutboundMessage {
  connectorId: ChannelConnectorId;
  address: ChannelAddress;
  text: string;
  attachments?: ChannelAttachmentMeta[];
  replyToId?: string;
}

// ── reactions ──────────────────────────────────────────────────────────

export interface ChannelReaction {
  id: string;
  connectorId: ChannelConnectorId;
  messageId: string;
  emoji: string;
  actor: ChannelIdentity;
  createdAt: string;
}

// ── retry / rate-limit / receipts ──────────────────────────────────────

export type ChannelDeliveryState = "queued" | "sent" | "delivered" | "failed" | "rate_limited";

export interface ChannelRetryState {
  attempts: number;
  maxAttempts: number;
  retryable: boolean;
  nextRetryAt?: string;
  lastError?: string;
}

export interface ChannelRateLimitState {
  limited: boolean;
  remaining?: number;
  resetAt?: string;
  retryAfterMs?: number;
}

export interface ChannelDeliveryReceipt {
  outboundId: string;
  connectorId: ChannelConnectorId;
  nativeMessageId?: string;
  state: ChannelDeliveryState;
  error?: string;
  retry: ChannelRetryState;
  rateLimit: ChannelRateLimitState;
  at: string;
}

// ── connector events ───────────────────────────────────────────────────

export type ChannelConnectorEvent =
  | { type: "inbound"; message: ChannelInboundMessage }
  | { type: "outbound"; outboundId: string; message: ChannelOutboundMessage }
  | { type: "reaction"; reaction: ChannelReaction }
  | { type: "receipt"; receipt: ChannelDeliveryReceipt }
  | { type: "rate-limit"; state: ChannelRateLimitState };

export type ChannelEventListener = (event: ChannelConnectorEvent) => void;

// ── status ─────────────────────────────────────────────────────────────

export const CHANNEL_RUNTIME_STATUSES = ["disconnected", "connecting", "connected", "unavailable"] as const;
export type ChannelRuntimeStatus = (typeof CHANNEL_RUNTIME_STATUSES)[number];

export interface ChannelConnectorStatus {
  id: ChannelConnectorId;
  kind: ChannelConnectorKind;
  displayName: string;
  configured: boolean;
  enabled: boolean;
  status: ChannelRuntimeStatus;
  statusMessage: string;
}

export interface ChannelCapabilities {
  send: boolean;
  receive: boolean;
  reactions: boolean;
  receipts: boolean;
}

// ── SPI ────────────────────────────────────────────────────────────────

export interface ChannelConnector {
  readonly id: ChannelConnectorId;
  readonly kind: ChannelConnectorKind;
  readonly displayName: string;
  readonly capabilities: ChannelCapabilities;
  status(): ChannelConnectorStatus;
  parseAddress(raw: string): ChannelAddress;
  formatAddress(address: ChannelAddress): string;
  send(message: ChannelOutboundMessage): Promise<ChannelDeliveryReceipt>;
  react(input: { messageId: string; emoji: string; actor?: ChannelIdentity }): Promise<ChannelReaction>;
  /** Bookkeeping-only retry of a prior failed / rate-limited outbound. */
  retry(outboundId: string): Promise<ChannelDeliveryReceipt>;
  rateLimit(): ChannelRateLimitState;
  onEvent(listener: ChannelEventListener): () => void;
}

export interface ChannelConnectorCreateInput<Config> {
  id: ChannelConnectorId;
  config: Config;
}

export interface ChannelConnectorFactory<Config = unknown> {
  readonly kind: ChannelConnectorKind;
  readonly metadata: { displayName: string };
  /** Throw on invalid config — the registry downgrades to a shadow. */
  decodeConfig(raw: unknown): Config;
  /** Reject (never sync-throw) on failure — the registry downgrades. */
  create(input: ChannelConnectorCreateInput<Config>): Promise<ChannelConnector>;
}

export type AnyChannelConnectorFactory = ChannelConnectorFactory<any>;

export function unsupportedChannelOperation(kind: string, op: string): Error {
  return Object.assign(new Error(`the ${kind} channel connector does not support ${op}`), {
    code: "channel_unsupported",
  });
}

export function isUnsupportedChannelOperation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: string }).code === "channel_unsupported");
}

export function emptyRateLimit(): ChannelRateLimitState {
  return { limited: false };
}

export function initialRetry(maxAttempts = 3): ChannelRetryState {
  return { attempts: 0, maxAttempts, retryable: true };
}

/**
 * Standing P0.1 approvals never apply to an external channel event.
 * Allow-once persists nothing; Always-allow / Advanced all-bots stay on
 * the bot that earned them; Deny is never persisted; credential asks
 * never auto-resolve. This function is the SPI pin — ingest must call
 * it and must not consult the approval broker.
 */
export function resolveApprovalsForChannelEvent(_event: ChannelInboundMessage): null {
  return null;
}

export const CHANNEL_EVENTS_INHERIT_STANDING_APPROVALS = false;
