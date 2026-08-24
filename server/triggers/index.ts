// Barrel for the P4 event-trigger algebra.

export {
  CHANNEL_EVENTS_INHERIT_STANDING_APPROVALS,
  DISCORD_LISTENER_MATCHES,
  ROUTINE_TRIGGER_KINDS,
  reactionToTriggerEvent,
  resolveApprovalsForChannelEvent,
  resolveApprovalsForTriggerEvent,
  type CronTrigger,
  type DiscordListenerMatch,
  type DiscordTrigger,
  type GithubTrigger,
  type GroupTrigger,
  type ListenerTrigger,
  type ParseTriggerOpts,
  type RoutineTrigger,
  type RoutineTriggerKind,
  type SlackTrigger,
  type TriggerEvent,
} from "./contracts.ts";
export { describeTrigger } from "./describe.ts";
export {
  inboundToTriggerEvent,
  reactionToDiscordEvent,
  triggerMatches,
  discordTextMentions,
} from "./match.ts";
export {
  parseDiscordChannel,
  parseDiscordEmoji,
  parseDiscordMatch,
  parseRoutineTrigger,
  triggerFilterComplete,
} from "./parse.ts";
export {
  isEventDrivenSchedule,
  isPollableSchedule,
  pollableListenerSchedules,
  scheduleFromTrigger,
  triggerFromSchedule,
  type DiscordListenerSchedule,
  type GroupSchedule,
  type PersistedRoutineSchedule,
} from "./schedule.ts";
