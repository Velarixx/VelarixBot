// Discord Gateway/REST protocol helpers. VelarixBot-native — no vendor SDK.
// Token values must never appear in logs, events, or thrown messages.

export const DISCORD_CHANNEL_KIND = "discord";
export const DISCORD_API_VERSION = 10;
export const DISCORD_MAX_CONTENT = 2000;
export const DISCORD_MAX_ATTACHMENTS = 10;
export const DISCORD_MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
export const DISCORD_MAX_DEDUP = 2_048;
export const DISCORD_DEFAULT_CONCURRENCY = 1;

/** Explicit Gateway intents. MESSAGE_CONTENT is required to read text. */
export const DISCORD_INTENTS = {
  GUILDS: 1 << 0,
  GUILD_MESSAGES: 1 << 9,
  GUILD_MESSAGE_REACTIONS: 1 << 10,
  DIRECT_MESSAGES: 1 << 12,
  DIRECT_MESSAGE_REACTIONS: 1 << 13,
  MESSAGE_CONTENT: 1 << 15,
} as const;

export const DISCORD_GATEWAY_INTENTS =
  DISCORD_INTENTS.GUILDS |
  DISCORD_INTENTS.GUILD_MESSAGES |
  DISCORD_INTENTS.GUILD_MESSAGE_REACTIONS |
  DISCORD_INTENTS.DIRECT_MESSAGES |
  DISCORD_INTENTS.DIRECT_MESSAGE_REACTIONS |
  DISCORD_INTENTS.MESSAGE_CONTENT;

export const DISCORD_OP = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
} as const;

export const DEFAULT_DISCORD_GATEWAY_URL = `wss://gateway.discord.gg/?v=${DISCORD_API_VERSION}&encoding=json`;
export const DEFAULT_DISCORD_API_ROOT = `https://discord.com/api/v${DISCORD_API_VERSION}`;

export interface DiscordAllowlists {
  guilds: string[];
  channels: string[];
  users: string[];
}

export interface DiscordIdentity {
  guildId?: string;
  channelId: string;
  userId: string;
  username?: string;
}

export interface DiscordBinding {
  guildId?: string;
  channelId?: string;
  threadId?: string;
  botId?: string;
  groupId?: string;
}

export interface DiscordConversationKey {
  guildId?: string;
  channelId: string;
  threadId?: string;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function redactDiscordToken(text: string, token: string): string {
  if (!token) return text;
  return text.split(token).join("[redacted]");
}

export function parseSnowflakeList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const entry = normalizeAllowlistEntry(item);
    if (!entry) continue;
    const key = entry.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

export function normalizeAllowlistEntry(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^\d{5,32}$/.test(trimmed)) return trimmed;
  const name = trimmed.replace(/^@/, "").trim();
  if (!name || /\s/.test(name) || name.includes("/")) return null;
  return `@${name}`;
}

export function parseAllowlists(raw: {
  guildAllowlist?: unknown;
  channelAllowlist?: unknown;
  userAllowlist?: unknown;
}): DiscordAllowlists {
  return {
    guilds: parseSnowflakeList(raw.guildAllowlist),
    channels: parseSnowflakeList(raw.channelAllowlist),
    users: parseSnowflakeList(raw.userAllowlist),
  };
}

export function allowlistsEmpty(lists: DiscordAllowlists): boolean {
  return lists.guilds.length === 0 && lists.channels.length === 0 && lists.users.length === 0;
}

/**
 * Default-deny: an empty allowlist authorizes nobody. A non-empty list is a
 * union across guild / channel / user entries — match any one to pass.
 */
export function isDiscordAuthorized(lists: DiscordAllowlists, identity: DiscordIdentity): boolean {
  if (allowlistsEmpty(lists)) return false;
  const guildId = identity.guildId?.trim();
  const channelId = identity.channelId.trim();
  const userId = identity.userId.trim();
  const username = identity.username?.replace(/^@/, "").trim().toLowerCase();
  for (const entry of lists.guilds) {
    if (guildId && entry === guildId) return true;
  }
  for (const entry of lists.channels) {
    if (channelId && entry === channelId) return true;
  }
  for (const entry of lists.users) {
    if (entry === userId) return true;
    if (username && entry.startsWith("@") && entry.slice(1).toLowerCase() === username) return true;
  }
  return false;
}

export function parseDiscordBindings(raw: unknown): DiscordBinding[] {
  if (!Array.isArray(raw)) return [];
  const out: DiscordBinding[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const channelId = typeof item.channelId === "string" ? item.channelId.trim() : "";
    const guildId = typeof item.guildId === "string" ? item.guildId.trim() : "";
    const threadId = typeof item.threadId === "string" ? item.threadId.trim() : "";
    const botId = typeof item.botId === "string" ? item.botId.trim() : "";
    const groupId = typeof item.groupId === "string" ? item.groupId.trim() : "";
    if (!channelId && !guildId && !threadId) continue;
    if (!botId && !groupId) continue;
    const key = discordConversationKey({
      ...(guildId ? { guildId } : {}),
      channelId: channelId || guildId || threadId,
      ...(threadId ? { threadId } : {}),
    });
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      ...(guildId ? { guildId } : {}),
      ...(channelId ? { channelId } : {}),
      ...(threadId ? { threadId } : {}),
      ...(botId ? { botId } : {}),
      ...(groupId ? { groupId } : {}),
    });
  }
  return out;
}

export function discordConversationKey(loc: DiscordConversationKey): string {
  const guild = loc.guildId?.trim() || "-";
  const channel = loc.channelId.trim();
  const thread = loc.threadId?.trim();
  return thread ? `${guild}/${channel}/${thread}` : `${guild}/${channel}`;
}

export function parseDiscordConversationKey(raw: string): DiscordConversationKey {
  const parts = raw.split("/").map((part) => part.trim()).filter((part) => part && part !== "-");
  if (parts.length >= 3) return { guildId: parts[0], channelId: parts[1], threadId: parts[2] };
  if (parts.length === 2) return { guildId: parts[0], channelId: parts[1] };
  return { channelId: parts[0] || raw };
}

/** Most-specific binding wins: thread, then channel, then guild. */
export function resolveDiscordBinding(
  bindings: DiscordBinding[],
  loc: DiscordConversationKey,
): DiscordBinding | null {
  const thread = loc.threadId?.trim();
  const channel = loc.channelId.trim();
  const guild = loc.guildId?.trim();
  if (thread) {
    const hit = bindings.find(
      (row) => row.threadId === thread && (!row.channelId || row.channelId === channel) && (!row.guildId || row.guildId === guild),
    );
    if (hit) return hit;
  }
  if (channel) {
    const hit = bindings.find((row) => row.channelId === channel && !row.threadId && (!row.guildId || row.guildId === guild));
    if (hit) return hit;
  }
  if (guild) {
    const hit = bindings.find((row) => row.guildId === guild && !row.channelId && !row.threadId);
    if (hit) return hit;
  }
  return null;
}

export function splitDiscordText(text: string, limit = DISCORD_MAX_CONTENT): string[] {
  const raw = String(text ?? "");
  if (!raw) return [];
  if (raw.length <= limit) return [raw];
  const chunks: string[] = [];
  let rest = raw;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);
    if (cut < limit * 0.5) cut = rest.lastIndexOf(" ", limit);
    if (cut < limit * 0.5) cut = limit;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks.filter(Boolean);
}

export interface DiscordAttachmentBound {
  id: string;
  name: string;
  mime?: string;
  sizeBytes?: number;
}

export function enforceDiscordAttachmentBounds(
  attachments: DiscordAttachmentBound[] | undefined,
  limits: { maxCount?: number; maxBytes?: number } = {},
): { ok: true; attachments: DiscordAttachmentBound[] } | { ok: false; error: string } {
  const list = attachments ?? [];
  const maxCount = limits.maxCount ?? DISCORD_MAX_ATTACHMENTS;
  const maxBytes = limits.maxBytes ?? DISCORD_MAX_ATTACHMENT_BYTES;
  if (list.length > maxCount) {
    return { ok: false, error: `Discord allows at most ${maxCount} attachments per message` };
  }
  for (const item of list) {
    if (item.sizeBytes !== undefined && (item.sizeBytes < 0 || !Number.isFinite(item.sizeBytes))) {
      return { ok: false, error: "Discord attachment size is invalid" };
    }
    if ((item.sizeBytes ?? 0) > maxBytes) {
      return { ok: false, error: `Discord attachment "${item.name}" exceeds the ${maxBytes} byte limit` };
    }
  }
  return { ok: true, attachments: list };
}

export class BoundedIdSet {
  private readonly ids = new Set<string>();
  private readonly order: string[] = [];
  constructor(private readonly max: number) {}

  has(id: string): boolean {
    return this.ids.has(id);
  }

  add(id: string): boolean {
    if (this.ids.has(id)) return false;
    this.ids.add(id);
    this.order.push(id);
    while (this.order.length > this.max) {
      const oldest = this.order.shift();
      if (oldest) this.ids.delete(oldest);
    }
    return true;
  }
}

export class ChannelConcurrency {
  private readonly inflight = new Map<string, number>();
  private readonly waiters = new Map<string, Array<() => void>>();

  constructor(private readonly max: number) {}

  async acquire(channelId: string): Promise<() => void> {
    const key = channelId || "*";
    while ((this.inflight.get(key) ?? 0) >= this.max) {
      await new Promise<void>((resolve) => {
        const queue = this.waiters.get(key) ?? [];
        queue.push(resolve);
        this.waiters.set(key, queue);
      });
    }
    this.inflight.set(key, (this.inflight.get(key) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = (this.inflight.get(key) ?? 1) - 1;
      if (next <= 0) this.inflight.delete(key);
      else this.inflight.set(key, next);
      const queue = this.waiters.get(key);
      const waiter = queue?.shift();
      if (waiter) waiter();
      if (queue && queue.length === 0) this.waiters.delete(key);
    };
  }
}
