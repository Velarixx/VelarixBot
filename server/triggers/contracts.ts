// Generic event-trigger algebra (Priority 4).
//
// Discriminated union for cron, GitHub, Slack, Discord, and grouped
// (any-of) triggers. Persist via the existing routine `schedule` JSON —
// this file is the algebra, not a second store.
//
// Discord is event-driven (Gateway inbound / reaction). GitHub and Slack
// stay on the existing poller. A group fires the same routine when any
// one child listener matches.
//
// P0.1 pin: external channel events NEVER inherit standing approvals.
// An inbound Discord event does not auto-resolve Allow-once, Always-allow,
// an Advanced all-bots matcher, or a credential ask.

import {
  CHANNEL_EVENTS_INHERIT_STANDING_APPROVALS,
  resolveApprovalsForChannelEvent,
  type ChannelInboundMessage,
  type ChannelReaction,
} from "../channels/contracts.ts";
import {
  DISCORD_LISTENER_MATCHES,
  type DiscordListenerMatch,
  type GithubListenerEvent,
  type SlackListenerMatch,
} from "../store.ts";

export { CHANNEL_EVENTS_INHERIT_STANDING_APPROVALS, DISCORD_LISTENER_MATCHES, resolveApprovalsForChannelEvent };
export type { DiscordListenerMatch };

export type CronTrigger =
  | { kind: "cron"; clock: "interval"; everyMinutes: number }
  | { kind: "cron"; clock: "daily"; time: string; timeZone?: string }
  | { kind: "cron"; clock: "weekdays"; time: string; timeZone?: string };

export type GithubTrigger = {
  kind: "github";
  everyMinutes?: number;
  repo?: { owner: string; name: string };
  events?: GithubListenerEvent[];
};

export type SlackTrigger = {
  kind: "slack";
  everyMinutes?: number;
  channel?: string;
  match?: SlackListenerMatch;
  keyword?: string;
};

export type DiscordTrigger = {
  kind: "discord";
  match: DiscordListenerMatch;
  channel?: string;
  keyword?: string;
  emoji?: string;
};

export type ListenerTrigger = GithubTrigger | SlackTrigger | DiscordTrigger;

export type GroupTrigger = {
  kind: "group";
  anyOf: ListenerTrigger[];
  everyMinutes?: number;
};

export type RoutineTrigger = CronTrigger | GithubTrigger | SlackTrigger | DiscordTrigger | GroupTrigger;

export const ROUTINE_TRIGGER_KINDS = ["cron", "github", "slack", "discord", "group"] as const;
export type RoutineTriggerKind = (typeof ROUTINE_TRIGGER_KINDS)[number];

/** One inbound fact the algebra can match. Cron is clock-driven, not an event. */
export type TriggerEvent =
  | {
      source: "github";
      id: string;
      type: string;
      repo?: { owner: string; name: string };
    }
  | {
      source: "slack";
      id: string;
      text: string;
      channel?: string;
    }
  | {
      source: "discord";
      id: string;
      kind: "message" | "reaction";
      text?: string;
      mentioned?: boolean;
      isDm?: boolean;
      isThread?: boolean;
      channelId?: string;
      guildId?: string;
      threadId?: string;
      emoji?: string;
      /** Bot snowflake when known — mention matches this id, not any <@>. */
      selfUserId?: string;
    };

export type ParseTriggerOpts = {
  strict?: boolean;
  strictTimeZone?: boolean;
};

/**
 * Standing P0.1 approvals never apply to an external trigger event.
 * Same pin as the channel SPI — ingest must call this and must not
 * consult the approval broker.
 */
export function resolveApprovalsForTriggerEvent(event: TriggerEvent): null {
  if (event.source === "discord" && event.kind === "message") {
    const inbound: ChannelInboundMessage = {
      id: event.id,
      connectorId: "discord",
      address: {
        connectorId: "discord",
        kind: "discord",
        target: event.threadId
          ? `${event.guildId ?? "-"}/${event.channelId ?? ""}/${event.threadId}`
          : event.guildId
            ? `${event.guildId}/${event.channelId ?? ""}`
            : (event.channelId ?? event.id),
      },
      sender: { connectorId: "discord", nativeId: "trigger" },
      text: event.text ?? "",
      attachments: [],
      createdAt: new Date(0).toISOString(),
    };
    return resolveApprovalsForChannelEvent(inbound);
  }
  return null;
}

export function reactionToTriggerEvent(reaction: ChannelReaction, extra: Partial<Extract<TriggerEvent, { source: "discord" }>> = {}): TriggerEvent {
  return {
    source: "discord",
    id: reaction.id,
    kind: "reaction",
    emoji: reaction.emoji,
    ...extra,
  };
}
