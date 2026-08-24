// Event matching for the trigger algebra. GitHub / Slack reuse the same
// filters the existing pollers apply. Discord is push (inbound / reaction).
// Group = any one child matches.
import { GITHUB_EVENT_TYPE } from "../listeners/github.ts";
import { slackMessageMatches } from "../listeners/slack.ts";
import { parseDiscordConversationKey } from "../channels/discord-protocol.ts";
import type { ChannelInboundMessage, ChannelReaction } from "../channels/contracts.ts";
import type { DiscordTrigger, ListenerTrigger, RoutineTrigger, TriggerEvent } from "./contracts.ts";

const DISCORD_MENTION_RE = /<@!?\d+>/;
const DISCORD_AT_RE = /(^|\s)@[A-Za-z0-9._-]+/;

export function discordTextMentions(text: string, selfUserId?: string): boolean {
  if (selfUserId) return text.includes(`<@${selfUserId}>`) || text.includes(`<@!${selfUserId}>`);
  return DISCORD_MENTION_RE.test(text) || DISCORD_AT_RE.test(text);
}

function channelEquals(want: string | undefined, got: string | undefined): boolean {
  if (!want) return true;
  if (!got) return false;
  return want.replace(/^#/, "").toLowerCase() === got.replace(/^#/, "").toLowerCase();
}

function githubMatches(trigger: Extract<RoutineTrigger, { kind: "github" }>, event: TriggerEvent): boolean {
  if (event.source !== "github") return false;
  if (trigger.repo && event.repo) {
    if (trigger.repo.owner !== event.repo.owner || trigger.repo.name !== event.repo.name) return false;
  }
  const allow = trigger.events ?? [];
  if (!allow.length) return false;
  const allowed = new Set(allow.map((e) => GITHUB_EVENT_TYPE[e]));
  return allowed.has(event.type) || allow.includes(event.type as (typeof allow)[number]);
}

function slackMatches(trigger: Extract<RoutineTrigger, { kind: "slack" }>, event: TriggerEvent): boolean {
  if (event.source !== "slack") return false;
  if (!trigger.match) return false;
  if (!channelEquals(trigger.channel, event.channel)) return false;
  return slackMessageMatches(event.text, trigger.match, trigger.keyword);
}

function discordChannelHit(trigger: DiscordTrigger, event: Extract<TriggerEvent, { source: "discord" }>): boolean {
  if (!trigger.channel) return true;
  return (
    channelEquals(trigger.channel, event.channelId) ||
    channelEquals(trigger.channel, event.threadId) ||
    channelEquals(trigger.channel, event.guildId)
  );
}

function discordMatches(trigger: DiscordTrigger, event: TriggerEvent): boolean {
  if (event.source !== "discord") return false;
  if (!discordChannelHit(trigger, event)) return false;
  switch (trigger.match) {
    case "mention":
      if (event.kind !== "message") return false;
      if (event.mentioned === true) return true;
      return discordTextMentions(event.text ?? "", event.selfUserId);
    case "dm":
      return event.kind === "message" && event.isDm === true;
    case "channel":
      return event.kind === "message" && event.isDm !== true && event.isThread !== true;
    case "keyword": {
      if (event.kind !== "message") return false;
      const needle = (trigger.keyword ?? "").trim().toLowerCase();
      if (!needle) return false;
      return (event.text ?? "").toLowerCase().includes(needle);
    }
    case "reaction":
      if (event.kind !== "reaction") return false;
      if (!trigger.emoji) return true;
      return event.emoji === trigger.emoji;
    case "thread":
      return event.kind === "message" && event.isThread === true;
  }
}

function listenerMatches(trigger: ListenerTrigger, event: TriggerEvent): boolean {
  if (trigger.kind === "github") return githubMatches(trigger, event);
  if (trigger.kind === "slack") return slackMatches(trigger, event);
  return discordMatches(trigger, event);
}

/** True when this event should fire the routine. Cron never matches an event. */
export function triggerMatches(trigger: RoutineTrigger, event: TriggerEvent): boolean {
  if (trigger.kind === "cron") return false;
  if (trigger.kind === "group") return trigger.anyOf.some((child) => listenerMatches(child, event));
  return listenerMatches(trigger, event);
}

export function inboundToTriggerEvent(
  message: ChannelInboundMessage,
  opts: { selfUserId?: string | null } = {},
): TriggerEvent {
  const loc = parseDiscordConversationKey(message.address.target);
  const isDm = !loc.guildId;
  const isThread = Boolean(loc.threadId);
  const selfUserId = opts.selfUserId?.trim() || undefined;
  const text = message.text ?? "";
  return {
    source: "discord",
    id: message.id,
    kind: "message",
    text,
    mentioned: discordTextMentions(text, selfUserId),
    isDm,
    isThread,
    channelId: loc.channelId,
    ...(loc.guildId ? { guildId: loc.guildId } : {}),
    ...(loc.threadId ? { threadId: loc.threadId } : {}),
    ...(selfUserId ? { selfUserId } : {}),
  };
}

export function reactionToDiscordEvent(
  reaction: ChannelReaction,
  loc?: { guildId?: string; channelId?: string; threadId?: string },
): TriggerEvent {
  return {
    source: "discord",
    id: reaction.id,
    kind: "reaction",
    emoji: reaction.emoji,
    ...(loc?.channelId ? { channelId: loc.channelId } : {}),
    ...(loc?.guildId ? { guildId: loc.guildId } : {}),
    ...(loc?.threadId ? { threadId: loc.threadId } : {}),
  };
}
