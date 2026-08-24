// Discord channel connector on the P1 ChannelConnector SPI.
// Token is supplied only at connect() from SecretStore — never persisted
// in connector config, logs, events, or argv.
import { newId } from "../contracts.ts";
import { rememberSecretValues, forgetSecretValues, redactSecrets } from "../redact-text.ts";
import {
  emptyRateLimit,
  initialRetry,
  resolveApprovalsForChannelEvent,
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
  type ChannelRuntimeStatus,
} from "./contracts.ts";
import {
  createDiscordGatewaySession,
  createNodeDiscordGatewayTransport,
  type DiscordGatewaySession,
  type DiscordGatewayTransport,
  type DiscordReadyUser,
  type DiscordScheduler,
} from "./discord-gateway.ts";
import {
  createDiscordRateLimitBuckets,
  createDiscordRestClient,
  discordCreateMessagePath,
  discordReactionPath,
  outboundRestBody,
  type DiscordRateLimitBuckets,
  type DiscordRestClient,
} from "./discord-rest.ts";
import {
  BoundedIdSet,
  ChannelConcurrency,
  DISCORD_CHANNEL_KIND,
  DISCORD_DEFAULT_CONCURRENCY,
  DISCORD_GATEWAY_INTENTS,
  DISCORD_MAX_DEDUP,
  allowlistsEmpty,
  discordConversationKey,
  enforceDiscordAttachmentBounds,
  isDiscordAuthorized,
  isRecord,
  parseAllowlists,
  parseDiscordBindings,
  parseDiscordConversationKey,
  redactDiscordToken,
  splitDiscordText,
  type DiscordAllowlists,
  type DiscordBinding,
} from "./discord-protocol.ts";

export { DISCORD_CHANNEL_KIND, DISCORD_GATEWAY_INTENTS } from "./discord-protocol.ts";
export type { DiscordAllowlists, DiscordBinding } from "./discord-protocol.ts";
export { createFakeDiscordGateway } from "./discord-gateway.ts";
export { createFakeDiscordRest } from "./discord-rest.ts";

export interface DiscordChannelConfig {
  enabled?: boolean;
  intents?: number;
  guildAllowlist?: string[];
  channelAllowlist?: string[];
  userAllowlist?: string[];
  defaultBotId?: string;
  defaultGroupId?: string;
  bindings?: DiscordBinding[];
  maxConcurrency?: number;
}

export interface DiscordConnectInput {
  token: string;
  transport?: DiscordGatewayTransport;
  rest?: DiscordRestClient;
  scheduler?: DiscordScheduler;
  gatewayUrl?: string;
}

export interface DiscordChannelConnector extends ChannelConnector {
  connect(input: DiscordConnectInput): Promise<void>;
  disconnect(): Promise<void>;
  applySettings(config: DiscordChannelConfig): void;
  selfUserId(): string | null;
  lastSequence(): number | null;
  sessionId(): string | null;
}

function iso(now: number): string {
  return new Date(now).toISOString();
}

export function decodeDiscordChannelConfig(raw: unknown): DiscordChannelConfig {
  if (raw === undefined) return {};
  if (!isRecord(raw)) throw new Error("discord channel: config must be an object");
  for (const key of ["token", "botToken", "gateway", "restUrl", "appId", "applicationId"]) {
    const value = raw[key];
    if (typeof value === "string" && value.trim()) {
      throw new Error("discord channel: token must be stored in SecretStore, not connector config");
    }
  }
  const intents = raw.intents;
  if (intents !== undefined && (typeof intents !== "number" || !Number.isInteger(intents) || intents < 0)) {
    throw new Error("discord channel: intents must be a non-negative integer");
  }
  const maxConcurrency = raw.maxConcurrency;
  if (
    maxConcurrency !== undefined &&
    (typeof maxConcurrency !== "number" || !Number.isInteger(maxConcurrency) || maxConcurrency < 1)
  ) {
    throw new Error("discord channel: maxConcurrency must be a positive integer");
  }
  const defaultBotId = typeof raw.defaultBotId === "string" ? raw.defaultBotId.trim() : "";
  const defaultGroupId = typeof raw.defaultGroupId === "string" ? raw.defaultGroupId.trim() : "";
  const lists = parseAllowlists(raw);
  return {
    ...(raw.enabled === true ? { enabled: true } : {}),
    ...(intents !== undefined ? { intents } : {}),
    ...(defaultBotId ? { defaultBotId } : {}),
    ...(defaultGroupId ? { defaultGroupId } : {}),
    bindings: parseDiscordBindings(raw.bindings),
    ...(maxConcurrency !== undefined ? { maxConcurrency } : {}),
    guildAllowlist: lists.guilds,
    channelAllowlist: lists.channels,
    userAllowlist: lists.users,
  };
}

export function parseDiscordAddress(raw: string, connectorId: string): ChannelAddress {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("discord channel: address must be non-empty");
  let target = trimmed;
  if (trimmed.startsWith("discord://")) target = trimmed.slice("discord://".length);
  else if (trimmed.startsWith("discord:")) target = trimmed.slice("discord:".length);
  else if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
    throw new Error(`discord channel: unsupported address scheme in "${trimmed}"`);
  }
  target = target.replace(/^\/+/, "").trim();
  if (!target || /\s/.test(target)) throw new Error("discord channel: address target must be a single token");
  return { connectorId, kind: DISCORD_CHANNEL_KIND, target, display: `discord:${target}` };
}

export function formatDiscordAddress(address: ChannelAddress): string {
  if (address.kind !== DISCORD_CHANNEL_KIND) {
    throw new Error(`discord channel: cannot format a ${address.kind} address`);
  }
  if (!address.target.trim()) throw new Error("discord channel: address target must be non-empty");
  return `discord:${address.target.trim()}`;
}

export function addressFromLocation(connectorId: string, loc: { guildId?: string; channelId: string; threadId?: string }): ChannelAddress {
  return parseDiscordAddress(discordConversationKey(loc), connectorId);
}

function destinationChannelId(address: ChannelAddress): string {
  const loc = parseDiscordConversationKey(address.target);
  return loc.threadId || loc.channelId;
}

export function createDiscordChannelConnector(input: {
  id: string;
  config?: DiscordChannelConfig;
  clock?: { now(): number };
  transport?: DiscordGatewayTransport;
  rest?: DiscordRestClient;
}): DiscordChannelConnector {
  const connectorId = input.id;
  const clock = input.clock ?? { now: () => Date.now() };
  const listeners = new Set<ChannelEventListener>();
  const inbound = new Map<string, ChannelInboundMessage>();
  const outbound = new Map<string, { message: ChannelOutboundMessage; receipt: ChannelDeliveryReceipt }>();
  const seenInbound = new BoundedIdSet(DISCORD_MAX_DEDUP);
  const buckets: DiscordRateLimitBuckets = createDiscordRateLimitBuckets(() => clock.now());
  let settings: DiscordChannelConfig = input.config ?? {};
  let allowlists = parseAllowlists(settings);
  let concurrency = new ChannelConcurrency(settings.maxConcurrency ?? DISCORD_DEFAULT_CONCURRENCY);
  let runtime: ChannelRuntimeStatus = "disconnected";
  let statusMessage = "Discord is disconnected.";
  let token = "";
  let selfId: string | null = null;
  let session: DiscordGatewaySession | null = null;
  let rest: DiscordRestClient = input.rest ?? createDiscordRestClient();
  let readyWait: { resolve: () => void; reject: (error: Error) => void } | null = null;

  function emit(event: Parameters<ChannelEventListener>[0]): void {
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch (error) {
        console.error("discord channel: listener threw", error);
      }
    }
  }

  function lists(): DiscordAllowlists {
    return allowlists;
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
      rateLimit: buckets.current(),
      at: iso(clock.now()),
      ...extra,
    };
  }

  function setStatus(next: ChannelRuntimeStatus, message: string): void {
    runtime = next;
    statusMessage = message;
  }

  function applySettings(config: DiscordChannelConfig): void {
    settings = config;
    allowlists = parseAllowlists({
      guildAllowlist: config.guildAllowlist,
      channelAllowlist: config.channelAllowlist,
      userAllowlist: config.userAllowlist,
    });
    concurrency = new ChannelConcurrency(config.maxConcurrency ?? DISCORD_DEFAULT_CONCURRENCY);
  }

  function inboundFromDispatch(data: unknown): ChannelInboundMessage | null {
    if (!isRecord(data)) return null;
    const id = typeof data.id === "string" ? data.id : "";
    if (!id || !seenInbound.add(id)) return null;
    const author = isRecord(data.author) ? data.author : {};
    const authorId = typeof author.id === "string" ? author.id : "";
    const authorBot = author.bot === true;
    if (!authorId) return null;
    if (selfId && authorId === selfId) return null;
    if (authorBot && (!selfId || authorId === selfId)) return null;
    const channelId = typeof data.channel_id === "string" ? data.channel_id : "";
    if (!channelId) return null;
    const guildId = typeof data.guild_id === "string" ? data.guild_id : "";
    const threadId =
      typeof data.thread_id === "string"
        ? data.thread_id
        : isRecord(data.thread) && typeof data.thread.id === "string"
          ? data.thread.id
          : "";
    const loc = {
      ...(guildId ? { guildId } : {}),
      channelId,
      ...(threadId && threadId !== channelId ? { threadId } : {}),
    };
    const identity = {
      ...(guildId ? { guildId } : {}),
      channelId: threadId || channelId,
      userId: authorId,
      ...(typeof author.username === "string" ? { username: author.username } : {}),
    };
    if (!isDiscordAuthorized(lists(), identity)) return null;
    const text = typeof data.content === "string" ? data.content : "";
    const attachments: ChannelAttachmentMeta[] = [];
    if (Array.isArray(data.attachments)) {
      for (const item of data.attachments) {
        if (!isRecord(item)) continue;
        const attId = typeof item.id === "string" ? item.id : "";
        const name = typeof item.filename === "string" ? item.filename : attId;
        if (!attId || !name) continue;
        attachments.push({
          id: attId,
          name,
          ...(typeof item.content_type === "string" ? { mime: item.content_type } : {}),
          ...(typeof item.size === "number" ? { sizeBytes: item.size } : {}),
        });
      }
    }
    const replyTo =
      isRecord(data.referenced_message) && typeof data.referenced_message.id === "string"
        ? data.referenced_message.id
        : isRecord(data.message_reference) && typeof data.message_reference.message_id === "string"
          ? data.message_reference.message_id
          : "";
    const sender: ChannelIdentity = {
      connectorId,
      nativeId: authorId,
      ...(typeof author.username === "string" ? { displayName: author.username, handle: author.username } : {}),
      ...(authorBot ? { bot: true } : {}),
    };
    const message: ChannelInboundMessage = {
      id,
      connectorId,
      address: addressFromLocation(connectorId, loc),
      sender,
      text,
      attachments,
      createdAt: iso(clock.now()),
      ...(replyTo ? { replyToId: replyTo } : {}),
    };
    resolveApprovalsForChannelEvent(message);
    inbound.set(message.id, message);
    return message;
  }

  function reactionFromDispatch(data: unknown): ChannelReaction | null {
    if (!isRecord(data)) return null;
    const messageId = typeof data.message_id === "string" ? data.message_id : "";
    const userId = typeof data.user_id === "string" ? data.user_id : "";
    const emojiObj = isRecord(data.emoji) ? data.emoji : {};
    const emoji = typeof emojiObj.name === "string" ? emojiObj.name : typeof emojiObj.id === "string" ? emojiObj.id : "";
    if (!messageId || !userId || !emoji) return null;
    if (selfId && userId === selfId) return null;
    const channelId = typeof data.channel_id === "string" ? data.channel_id : "";
    const guildId = typeof data.guild_id === "string" ? data.guild_id : "";
    if (
      !isDiscordAuthorized(lists(), {
        ...(guildId ? { guildId } : {}),
        channelId: channelId || messageId,
        userId,
      })
    ) {
      return null;
    }
    return {
      id: newId(),
      connectorId,
      messageId,
      emoji,
      actor: { connectorId, nativeId: userId },
      createdAt: iso(clock.now()),
    };
  }

  function handleDispatch(event: string, data: unknown): void {
    if (event === "MESSAGE_CREATE") {
      const message = inboundFromDispatch(data);
      if (message) emit({ type: "inbound", message });
      return;
    }
    if (event === "MESSAGE_REACTION_ADD") {
      const reaction = reactionFromDispatch(data);
      if (reaction) emit({ type: "reaction", reaction });
    }
  }

  async function connect(opts: DiscordConnectInput): Promise<void> {
    const next = opts.token.trim();
    if (!next) throw new Error("discord channel: token is required to connect");
    await disconnect();
    token = next;
    rememberSecretValues([token]);
    rest = opts.rest ?? input.rest ?? createDiscordRestClient();
    const transport = opts.transport ?? input.transport ?? createNodeDiscordGatewayTransport();
    setStatus("connecting", "Connecting to Discord…");
    const opened = new Promise<void>((resolve, reject) => {
      readyWait = { resolve, reject };
    });
    session = createDiscordGatewaySession({
      transport,
      scheduler: opts.scheduler,
      intents: settings.intents ?? DISCORD_GATEWAY_INTENTS,
      gatewayUrl: opts.gatewayUrl,
      listener: {
        onReady(user: DiscordReadyUser) {
          selfId = user.id || selfId;
          setStatus("connected", "Discord Gateway is connected.");
          readyWait?.resolve();
          readyWait = null;
        },
        onResumed() {
          setStatus("connected", "Discord Gateway resumed.");
          readyWait?.resolve();
          readyWait = null;
        },
        onDispatch(event, data) {
          handleDispatch(event, data);
        },
        onClose(code, reason) {
          if (!token) {
            setStatus("disconnected", "Discord is disconnected.");
            return;
          }
          if (runtime === "connected" || runtime === "connecting") {
            setStatus("connecting", redactDiscordToken(`Discord Gateway closed (${code} ${reason}). Reconnecting…`, token));
          }
        },
        onError(message) {
          const safe = redactSecrets(redactDiscordToken(message, token));
          setStatus("unavailable", safe);
          readyWait?.reject(new Error(safe));
          readyWait = null;
        },
      },
    });
    session.connect(token);
    await opened;
  }

  async function disconnect(): Promise<void> {
    const previous = token;
    token = "";
    selfId = null;
    readyWait?.reject(new Error("Discord disconnected."));
    readyWait = null;
    session?.disconnect();
    session = null;
    if (previous) forgetSecretValues([previous]);
    setStatus("disconnected", "Discord is disconnected.");
  }

  async function deliver(
    outboundId: string,
    message: ChannelOutboundMessage,
    prior?: ChannelRetryState,
  ): Promise<ChannelDeliveryReceipt> {
    const attempts = (prior?.attempts ?? 0) + 1;
    const retry: ChannelRetryState = {
      attempts,
      maxAttempts: prior?.maxAttempts ?? 3,
      retryable: attempts < (prior?.maxAttempts ?? 3),
      ...(prior?.lastError ? { lastError: prior.lastError } : {}),
    };
    if (!token || !session?.connected()) {
      retry.lastError = "disconnected";
      const receipt = receiptFor(outboundId, "failed", retry, { error: "Discord is disconnected." });
      outbound.set(outboundId, { message, receipt });
      emit({ type: "receipt", receipt });
      return receipt;
    }
    const bounds = enforceDiscordAttachmentBounds(message.attachments);
    if (!bounds.ok) {
      retry.lastError = bounds.error;
      retry.retryable = false;
      const receipt = receiptFor(outboundId, "failed", retry, { error: bounds.error });
      outbound.set(outboundId, { message, receipt });
      emit({ type: "receipt", receipt });
      return receipt;
    }
    const channelId = destinationChannelId(message.address);
    const path = discordCreateMessagePath(channelId);
    if (buckets.limited(path)) {
      const rateLimit = buckets.current();
      retry.retryable = true;
      retry.lastError = "rate limited";
      if (rateLimit.resetAt) retry.nextRetryAt = rateLimit.resetAt;
      const receipt = receiptFor(outboundId, "rate_limited", retry, { error: "rate limited" });
      outbound.set(outboundId, { message, receipt });
      emit({ type: "rate-limit", state: rateLimit });
      emit({ type: "receipt", receipt });
      return receipt;
    }
    const chunks = splitDiscordText(redactSecrets(message.text));
    if (!chunks.length) {
      retry.lastError = "empty";
      retry.retryable = false;
      const receipt = receiptFor(outboundId, "failed", retry, { error: "outbound text is empty after redaction" });
      outbound.set(outboundId, { message, receipt });
      emit({ type: "receipt", receipt });
      return receipt;
    }
    const release = await concurrency.acquire(channelId);
    try {
      let nativeMessageId: string | undefined;
      for (const [index, chunk] of chunks.entries()) {
        const response = await rest.request({
          method: "POST",
          path,
          token,
          body: outboundRestBody({
            text: chunk,
            ...(index === 0 && message.replyToId ? { replyToId: message.replyToId } : {}),
            attachments: bounds.attachments,
          }),
        });
        const rateLimit = buckets.observe(path, response.headers, response.status);
        if (rateLimit.limited || response.status === 429) {
          retry.retryable = true;
          retry.lastError = "rate limited";
          if (rateLimit.resetAt) retry.nextRetryAt = rateLimit.resetAt;
          const receipt = receiptFor(outboundId, "rate_limited", retry, { error: "rate limited" });
          outbound.set(outboundId, { message, receipt });
          emit({ type: "rate-limit", state: rateLimit });
          emit({ type: "receipt", receipt });
          return receipt;
        }
        if (isRecord(response.json) && typeof response.json.id === "string") nativeMessageId = response.json.id;
      }
      const receipt = receiptFor(outboundId, "sent", { ...retry, retryable: false }, nativeMessageId ? { nativeMessageId } : {});
      outbound.set(outboundId, { message, receipt });
      emit({ type: "outbound", outboundId, message });
      emit({ type: "receipt", receipt });
      return receipt;
    } catch (error) {
      const raw = error instanceof Error ? error.message : "send failed";
      const safe = redactSecrets(redactDiscordToken(raw, token));
      retry.lastError = safe;
      const receipt = receiptFor(outboundId, "failed", retry, { error: safe });
      outbound.set(outboundId, { message, receipt });
      emit({ type: "receipt", receipt });
      return receipt;
    } finally {
      release();
    }
  }

  const connector: DiscordChannelConnector = {
    id: connectorId,
    kind: DISCORD_CHANNEL_KIND,
    displayName: "Discord",
    capabilities: { send: true, receive: true, reactions: true, receipts: true },

    status() {
      const configured = Boolean(token);
      return {
        id: connectorId,
        kind: DISCORD_CHANNEL_KIND,
        displayName: "Discord",
        configured,
        enabled: settings.enabled === true && configured,
        status: runtime,
        statusMessage,
      };
    },

    parseAddress(raw) {
      return parseDiscordAddress(raw, connectorId);
    },

    formatAddress: formatDiscordAddress,

    async send(message) {
      if (message.connectorId !== connectorId) {
        throw new Error("discord channel: outbound connectorId does not match this connector");
      }
      if (message.address.kind !== DISCORD_CHANNEL_KIND || message.address.connectorId !== connectorId) {
        throw new Error("discord channel: outbound address is not a discord address for this connector");
      }
      const outboundId = newId();
      return deliver(outboundId, message);
    },

    async react(input) {
      if (!token || !session?.connected()) throw new Error("discord channel: disconnected");
      const emoji = input.emoji.trim();
      if (!emoji) throw new Error("discord channel: reaction emoji must be non-empty");
      const known = inbound.get(input.messageId);
      const stored = [...outbound.values()].find(
        (row) => row.receipt.nativeMessageId === input.messageId || row.receipt.outboundId === input.messageId,
      );
      const messageId = known?.id ?? stored?.receipt.nativeMessageId ?? input.messageId;
      const channelId = known ? destinationChannelId(known.address) : stored ? destinationChannelId(stored.message.address) : "";
      if (!channelId) throw new Error("discord channel: unknown message for reaction");
      const path = discordReactionPath(channelId, messageId, emoji);
      const response = await rest.request({ method: "PUT", path, token });
      buckets.observe(path, response.headers, response.status);
      const actor = input.actor ?? {
        connectorId,
        nativeId: selfId ?? "bot",
        bot: true,
      };
      const reaction: ChannelReaction = {
        id: newId(),
        connectorId,
        messageId,
        emoji,
        actor: { ...actor, connectorId },
        createdAt: iso(clock.now()),
      };
      emit({ type: "reaction", reaction });
      return reaction;
    },

    async retry(outboundId) {
      const row = outbound.get(outboundId);
      if (!row) throw new Error("discord channel: unknown outbound id");
      if (row.receipt.state === "sent" || row.receipt.state === "delivered") return row.receipt;
      if (!row.receipt.retry.retryable) return row.receipt;
      return deliver(outboundId, row.message, row.receipt.retry);
    },

    rateLimit() {
      return buckets.current();
    },

    onEvent(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    connect,
    disconnect,
    applySettings,
    selfUserId() {
      return selfId;
    },
    lastSequence() {
      return session?.lastSequence() ?? null;
    },
    sessionId() {
      return session?.sessionId() ?? null;
    },
  };

  applySettings(settings);
  return connector;
}

export const DiscordChannelFactory: ChannelConnectorFactory<DiscordChannelConfig> = {
  kind: DISCORD_CHANNEL_KIND,
  metadata: { displayName: "Discord" },
  decodeConfig: decodeDiscordChannelConfig,
  async create({ id, config }) {
    return createDiscordChannelConnector({ id, config });
  },
};

// Keep identity/receipt type names on the public surface.
export type DiscordSenderIdentity = ChannelIdentity;
export type DiscordDeliveryReceipt = ChannelDeliveryReceipt;
export type DiscordRetryState = ReturnType<typeof initialRetry>;
export type DiscordRateLimit = ChannelRateLimitState;
export { emptyRateLimit, allowlistsEmpty };
