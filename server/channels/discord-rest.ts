// Discord REST client + per-route rate-limit buckets. Injectable fetch so
// CI never talks to discord.com. Token is redacted from every error.
import {
  DEFAULT_DISCORD_API_ROOT,
  redactDiscordToken,
  type DiscordAttachmentBound,
} from "./discord-protocol.ts";
import type { ChannelRateLimitState } from "./contracts.ts";

export interface DiscordRestRequest {
  method: string;
  path: string;
  body?: unknown;
  token: string;
}

export interface DiscordRestResponse {
  status: number;
  headers: Record<string, string>;
  json: unknown;
}

export interface DiscordRestClient {
  request(req: DiscordRestRequest): Promise<DiscordRestResponse>;
}

export interface DiscordRateLimitBuckets {
  observe(path: string, headers: Record<string, string>, status: number): ChannelRateLimitState;
  current(): ChannelRateLimitState;
  limited(path?: string): boolean;
}

function header(headers: Record<string, string>, name: string): string | undefined {
  const key = Object.keys(headers).find((entry) => entry.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : undefined;
}

export function createDiscordRateLimitBuckets(now: () => number = () => Date.now()): DiscordRateLimitBuckets {
  const buckets = new Map<string, { remaining: number; resetAt: number; retryAfterMs?: number }>();
  let last: ChannelRateLimitState = { limited: false };

  function snapshot(path = "*"): ChannelRateLimitState {
    const row = buckets.get(path) ?? buckets.get("*");
    if (!row) return { limited: false };
    const limited = row.remaining <= 0 && row.resetAt > now();
    return {
      limited,
      remaining: Math.max(0, row.remaining),
      resetAt: new Date(row.resetAt).toISOString(),
      ...(row.retryAfterMs !== undefined ? { retryAfterMs: row.retryAfterMs } : {}),
    };
  }

  return {
    observe(path, headers, status) {
      const remainingRaw = header(headers, "x-ratelimit-remaining");
      const resetAfterRaw = header(headers, "x-ratelimit-reset-after");
      const retryAfterRaw = header(headers, "retry-after");
      const remaining = remainingRaw !== undefined ? Number(remainingRaw) : status === 429 ? 0 : undefined;
      const retryAfterSec = retryAfterRaw !== undefined ? Number(retryAfterRaw) : undefined;
      const resetAfterSec = resetAfterRaw !== undefined ? Number(resetAfterRaw) : retryAfterSec;
      const retryAfterMs =
        retryAfterSec !== undefined && Number.isFinite(retryAfterSec) ? Math.max(0, Math.round(retryAfterSec * 1000)) : undefined;
      const resetAt =
        resetAfterSec !== undefined && Number.isFinite(resetAfterSec) ? now() + Math.max(0, resetAfterSec * 1000) : now();
      const next = {
        remaining: remaining !== undefined && Number.isFinite(remaining) ? remaining : status === 429 ? 0 : 1,
        resetAt,
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      };
      buckets.set(path, next);
      buckets.set("*", next);
      last = snapshot(path);
      if (status === 429) last = { ...last, limited: true, remaining: 0, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
      return { ...last };
    },
    current() {
      return { ...last };
    },
    limited(path) {
      return snapshot(path).limited;
    },
  };
}

export function createFakeDiscordRest(): DiscordRestClient & {
  sent: Array<{ method: string; path: string; body: unknown }>;
  reactions: Array<{ path: string; emoji: string }>;
  nextStatus: number;
  nextHeaders: Record<string, string>;
  nextJson: unknown;
  hold: Promise<void> | null;
} {
  const fake = {
    sent: [] as Array<{ method: string; path: string; body: unknown }>,
    reactions: [] as Array<{ path: string; emoji: string }>,
    nextStatus: 200,
    nextHeaders: { "x-ratelimit-remaining": "4", "x-ratelimit-reset-after": "1" } as Record<string, string>,
    nextJson: { id: "native-1" } as unknown,
    hold: null as Promise<void> | null,
    async request(req: DiscordRestRequest) {
      if (fake.hold) await fake.hold;
      fake.sent.push({ method: req.method, path: req.path, body: req.body ?? null });
      if (req.method === "PUT" && req.path.includes("/reactions/")) {
        const emoji = decodeURIComponent(req.path.split("/reactions/")[1]?.split("/")[0] ?? "");
        fake.reactions.push({ path: req.path, emoji });
      }
      const status = fake.nextStatus;
      const headers = { ...fake.nextHeaders };
      const json = fake.nextJson;
      if (status === 200 && req.method === "POST" && req.path.endsWith("/messages")) {
        const id = `native-${fake.sent.length}`;
        return { status, headers, json: { id, ...(typeof json === "object" && json ? json : {}) } };
      }
      return { status, headers, json };
    },
  };
  return fake;
}

export function createDiscordRestClient(
  fetchImpl: typeof fetch = fetch,
  apiRoot = DEFAULT_DISCORD_API_ROOT,
): DiscordRestClient {
  return {
    async request(req) {
      const url = `${apiRoot}${req.path.startsWith("/") ? req.path : `/${req.path}`}`;
      let res: Response;
      try {
        res = await fetchImpl(url, {
          method: req.method,
          headers: {
            authorization: `Bot ${req.token}`,
            "content-type": "application/json",
          },
          ...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}),
        });
      } catch (error) {
        const raw = error instanceof Error ? error.message : "network error";
        throw new Error(redactDiscordToken(`Could not reach Discord REST (${raw}).`, req.token));
      }
      const raw = await res.text();
      const headers: Record<string, string> = {};
      res.headers.forEach((value, key) => {
        headers[key] = value;
      });
      let json: unknown = null;
      if (raw) {
        try {
          json = JSON.parse(raw);
        } catch {
          json = raw;
        }
      }
      if (!res.ok && res.status !== 429) {
        const detail = typeof json === "string" ? json : JSON.stringify(json ?? "");
        throw new Error(
          redactDiscordToken(
            res.status === 401 || res.status === 403
              ? "Discord rejected the bot token. Paste a new token from the Discord Developer Portal."
              : `Discord REST returned HTTP ${res.status}${detail ? `: ${detail.slice(0, 180)}` : "."}`,
            req.token,
          ),
        );
      }
      return { status: res.status, headers, json };
    },
  };
}

export function discordCreateMessagePath(channelId: string): string {
  return `/channels/${encodeURIComponent(channelId)}/messages`;
}

export function discordReactionPath(channelId: string, messageId: string, emoji: string): string {
  return `/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}/reactions/${encodeURIComponent(emoji)}/@me`;
}

export function outboundRestBody(input: {
  text: string;
  replyToId?: string;
  attachments?: DiscordAttachmentBound[];
}): Record<string, unknown> {
  const body: Record<string, unknown> = { content: input.text };
  if (input.replyToId) {
    body.message_reference = { message_id: input.replyToId, fail_if_not_exists: false };
  }
  return body;
}
