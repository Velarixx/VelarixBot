// Outbound Slack poll for kind: "listener" source: "slack".
// One channel or DM + mention | keyword | message. Uses the existing
// Composio Slack toolkit — no Slack bot token, Events API, or Socket Mode.
import type { AppConfig } from "../config.ts";
import * as composio from "../composio.ts";
import type { SlackListenerMatch, SlackListenerSchedule } from "../store.ts";

export const SLACK_NOT_CONNECTED =
  "slack is not connected. Call connect_app with slug slack first. Never ask the user to paste a token in chat.";

export interface SlackMessage {
  id: string;
  text: string;
}

export interface SlackFeed {
  listMessages(channel: string, cfg: AppConfig): Promise<SlackMessage[]>;
}

const SLACK_ID_RE = /^[CDG][A-Z0-9]{8,}$/i;

function compareTs(a: string, b: string): number {
  const an = Number(a);
  const bn = Number(b);
  if (Number.isFinite(an) && Number.isFinite(bn) && an !== bn) return an < bn ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function maxTs(messages: SlackMessage[]): string | null {
  let max: string | null = null;
  for (const msg of messages) {
    if (!msg.id) continue;
    if (max === null || compareTs(msg.id, max) > 0) max = msg.id;
  }
  return max;
}

export function slackMessageMatches(text: string, match: SlackListenerMatch, keyword?: string): boolean {
  if (match === "message") return true;
  if (match === "mention") return /<@[A-Z0-9]+>/i.test(text) || /(^|\s)@[A-Za-z0-9._-]+/.test(text);
  const needle = (keyword ?? "").trim().toLowerCase();
  if (!needle) return false;
  return text.toLowerCase().includes(needle);
}

/** Newer-than-cursor messages that match. First poll only primes the cursor. */
export function selectSlackMatch(
  messages: SlackMessage[],
  match: SlackListenerMatch,
  keyword: string | undefined,
  cursor: string | null,
): { match: SlackMessage | null; nextCursor: string | null } {
  const newest = maxTs(messages);
  const nextCursor = newest ?? cursor;
  if (!cursor) return { match: null, nextCursor };
  let hit: SlackMessage | null = null;
  for (const msg of messages) {
    if (!msg.id || compareTs(msg.id, cursor) <= 0) continue;
    if (!slackMessageMatches(msg.text, match, keyword)) continue;
    if (!hit || compareTs(msg.id, hit.id) > 0) hit = msg;
  }
  return { match: hit, nextCursor };
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function collectArrays(raw: unknown): unknown[] {
  const out: unknown[] = [];
  const walk = (v: unknown, depth: number) => {
    if (depth > 4 || v == null) return;
    if (Array.isArray(v)) {
      out.push(v);
      return;
    }
    const rec = asRecord(v);
    if (!rec) return;
    for (const key of ["messages", "channels", "items", "data", "results"]) {
      if (key in rec) walk(rec[key], depth + 1);
    }
  };
  walk(raw, 0);
  return out;
}

export function extractSlackMessages(raw: unknown): SlackMessage[] {
  const seen = new Set<string>();
  const out: SlackMessage[] = [];
  for (const arr of collectArrays(raw)) {
    if (!Array.isArray(arr)) continue;
    for (const row of arr) {
      const rec = asRecord(row);
      if (!rec) continue;
      const id = String(rec.ts ?? rec.id ?? rec.timestamp ?? "").trim();
      const text = String(rec.text ?? rec.message ?? "");
      if (!id || seen.has(id)) continue;
      if (rec.type && rec.type !== "message") continue;
      seen.add(id);
      out.push({ id, text });
    }
  }
  return out;
}

function extractChannelId(raw: unknown, want: string): string | null {
  const target = want.replace(/^#/, "").toLowerCase();
  for (const arr of collectArrays(raw)) {
    if (!Array.isArray(arr)) continue;
    for (const row of arr) {
      const rec = asRecord(row);
      if (!rec) continue;
      const id = String(rec.id ?? rec.channel_id ?? rec.channel ?? "").trim();
      const name = String(rec.name ?? rec.channel_name ?? "").replace(/^#/, "").toLowerCase();
      if (id && (id.toLowerCase() === want.toLowerCase() || name === target)) return id;
    }
  }
  const rec = asRecord(raw);
  const nested = rec ? asRecord(rec.channel) ?? asRecord(rec.data) : null;
  const id = String(nested?.id ?? rec?.id ?? rec?.channel_id ?? "").trim();
  return SLACK_ID_RE.test(id) ? id : null;
}

export async function resolveSlackChannel(
  channel: string,
  cfg: AppConfig,
  tool: typeof composio.composioTool = composio.composioTool,
): Promise<string> {
  const trimmed = channel.trim();
  if (SLACK_ID_RE.test(trimmed)) return trimmed;
  const query = trimmed.replace(/^#/, "").replace(/^@/, "");
  const types = trimmed.startsWith("@") ? "im,mpim" : "public_channel,private_channel,mpim,im";
  const found = await tool(cfg, "SLACK_FIND_CHANNELS", { query, exact_match: true, types, limit: 20 });
  const id = extractChannelId(found, query);
  if (id) return id;
  throw new Error("skipped: Slack channel or DM not found");
}

export function createSlackFeed(tool: typeof composio.composioTool = composio.composioTool): SlackFeed {
  return {
    async listMessages(channel, cfg) {
      const id = await resolveSlackChannel(channel, cfg, tool);
      const raw = await tool(cfg, "SLACK_FETCH_CONVERSATION_HISTORY", { channel: id, limit: 30 });
      return extractSlackMessages(raw);
    },
  };
}

export async function pollSlackListener(
  schedule: SlackListenerSchedule,
  cursor: string | null,
  deps: {
    cfg: AppConfig;
    feed: SlackFeed;
    connectionStatus?: (
      cfg: AppConfig,
      slugs: string[],
      botId?: string,
    ) => Promise<Record<string, { connected: boolean; status?: string }>>;
  },
): Promise<{ status: "match" | "no-match" | "skip"; reason?: string; cursor: string | null }> {
  const channel = schedule.channel?.trim();
  const match = schedule.match;
  if (!channel || !match || (match === "keyword" && !schedule.keyword?.trim())) {
    return { status: "skip", reason: "skipped: slack listener needs a channel or DM and a match (mention, keyword, or message)", cursor };
  }
  if (!deps.cfg.composio?.key) {
    return { status: "skip", reason: SLACK_NOT_CONNECTED, cursor };
  }
  const statusFn = deps.connectionStatus ?? composio.connectionStatus;
  const status = await statusFn(deps.cfg, ["slack"]).catch(() => ({ slack: { connected: false, status: "unknown" } }));
  if (!status.slack?.connected) return { status: "skip", reason: SLACK_NOT_CONNECTED, cursor };
  const messages = await deps.feed.listMessages(channel, deps.cfg);
  const { match: hit, nextCursor } = selectSlackMatch(messages, match, schedule.keyword, cursor);
  if (hit) return { status: "match", cursor: nextCursor };
  return { status: "no-match", cursor: nextCursor };
}
