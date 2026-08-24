// Map the trigger algebra onto the persisted RoutineSchedule (and back).
// Existing interval / daily / weekdays / github / slack JSON stays as-is.
import type {
  GithubListenerSchedule,
  RoutineSchedule,
  SlackListenerSchedule,
} from "../store.ts";
import type { DiscordTrigger, GithubTrigger, ListenerTrigger, RoutineTrigger, SlackTrigger } from "./contracts.ts";

export type DiscordListenerSchedule = {
  kind: "listener";
  source: "discord";
  everyMinutes?: number;
  match?: DiscordTrigger["match"];
  channel?: string;
  keyword?: string;
  emoji?: string;
};

export type GroupSchedule = {
  kind: "group";
  anyOf: Array<GithubListenerSchedule | SlackListenerSchedule | DiscordListenerSchedule>;
  everyMinutes?: number;
};

export type PersistedRoutineSchedule = RoutineSchedule | DiscordListenerSchedule | GroupSchedule;

function githubToSchedule(trigger: GithubTrigger): GithubListenerSchedule {
  return {
    kind: "listener",
    source: "github",
    everyMinutes: trigger.everyMinutes ?? 15,
    ...(trigger.repo ? { repo: trigger.repo } : {}),
    ...(trigger.events?.length ? { events: trigger.events } : {}),
  };
}

function slackToSchedule(trigger: SlackTrigger): SlackListenerSchedule {
  return {
    kind: "listener",
    source: "slack",
    everyMinutes: trigger.everyMinutes ?? 15,
    ...(trigger.channel ? { channel: trigger.channel } : {}),
    ...(trigger.match ? { match: trigger.match } : {}),
    ...(trigger.match === "keyword" && trigger.keyword ? { keyword: trigger.keyword } : {}),
  };
}

function discordToSchedule(trigger: DiscordTrigger): DiscordListenerSchedule {
  return {
    kind: "listener",
    source: "discord",
    match: trigger.match,
    ...(trigger.channel ? { channel: trigger.channel } : {}),
    ...(trigger.match === "keyword" && trigger.keyword ? { keyword: trigger.keyword } : {}),
    ...(trigger.match === "reaction" && trigger.emoji ? { emoji: trigger.emoji } : {}),
  };
}

function listenerToSchedule(trigger: ListenerTrigger): GithubListenerSchedule | SlackListenerSchedule | DiscordListenerSchedule {
  if (trigger.kind === "github") return githubToSchedule(trigger);
  if (trigger.kind === "slack") return slackToSchedule(trigger);
  return discordToSchedule(trigger);
}

export function scheduleFromTrigger(trigger: RoutineTrigger): PersistedRoutineSchedule {
  switch (trigger.kind) {
    case "cron":
      if (trigger.clock === "interval") return { kind: "interval", everyMinutes: trigger.everyMinutes };
      return {
        kind: trigger.clock,
        time: trigger.time,
        ...(trigger.timeZone ? { timeZone: trigger.timeZone } : {}),
      };
    case "github":
      return githubToSchedule(trigger);
    case "slack":
      return slackToSchedule(trigger);
    case "discord":
      return discordToSchedule(trigger);
    case "group":
      return {
        kind: "group",
        anyOf: trigger.anyOf.map(listenerToSchedule),
        everyMinutes: trigger.everyMinutes ?? 15,
      };
  }
}

export function triggerFromSchedule(schedule: PersistedRoutineSchedule): RoutineTrigger {
  if (schedule.kind === "interval") return { kind: "cron", clock: "interval", everyMinutes: schedule.everyMinutes };
  if (schedule.kind === "daily" || schedule.kind === "weekdays") {
    return {
      kind: "cron",
      clock: schedule.kind,
      time: schedule.time,
      ...(schedule.timeZone ? { timeZone: schedule.timeZone } : {}),
    };
  }
  if (schedule.kind === "group") {
    return {
      kind: "group",
      anyOf: schedule.anyOf.map((child) => triggerFromSchedule(child) as ListenerTrigger),
      everyMinutes: schedule.everyMinutes ?? 15,
    };
  }
  if (schedule.source === "github") {
    return {
      kind: "github",
      everyMinutes: schedule.everyMinutes,
      ...(schedule.repo ? { repo: schedule.repo } : {}),
      ...(schedule.events?.length ? { events: schedule.events } : {}),
    };
  }
  if (schedule.source === "slack") {
    return {
      kind: "slack",
      everyMinutes: schedule.everyMinutes,
      ...(schedule.channel ? { channel: schedule.channel } : {}),
      ...(schedule.match ? { match: schedule.match } : {}),
      ...(schedule.match === "keyword" && schedule.keyword ? { keyword: schedule.keyword } : {}),
    };
  }
  return {
    kind: "discord",
    match: schedule.match ?? "channel",
    ...(schedule.channel ? { channel: schedule.channel } : {}),
    ...(schedule.match === "keyword" && schedule.keyword ? { keyword: schedule.keyword } : {}),
    ...(schedule.match === "reaction" && schedule.emoji ? { emoji: schedule.emoji } : {}),
  };
}

export function isPollableSchedule(schedule: PersistedRoutineSchedule): boolean {
  if (schedule.kind === "listener") return schedule.source === "github" || schedule.source === "slack";
  if (schedule.kind === "group") return schedule.anyOf.some(isPollableSchedule);
  return false;
}

export function isEventDrivenSchedule(schedule: PersistedRoutineSchedule): boolean {
  if (schedule.kind === "listener") return schedule.source === "discord";
  if (schedule.kind === "group") {
    return schedule.anyOf.some((child) => child.kind === "listener" && child.source === "discord");
  }
  return false;
}

export function pollableListenerSchedules(
  schedule: PersistedRoutineSchedule,
): Array<GithubListenerSchedule | SlackListenerSchedule> {
  if (schedule.kind === "listener" && (schedule.source === "github" || schedule.source === "slack")) {
    return [schedule];
  }
  if (schedule.kind === "group") {
    return schedule.anyOf.flatMap(pollableListenerSchedules);
  }
  return [];
}
