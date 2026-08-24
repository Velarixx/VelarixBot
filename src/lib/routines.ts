// Routine schedule labels + create/edit payload helpers for RoutinesPanel.
import type {
  DiscordListenerMatch,
  GithubListenerEvent,
  ListenerSchedule,
  RoutineSchedule,
  SlackListenerMatch,
} from "@/state/store";

export const GITHUB_LISTENER_EVENTS: Array<[GithubListenerEvent, string]> = [
  ["push", "Push"],
  ["pull_request", "Pull request"],
  ["issues", "Issues"],
  ["issue_comment", "Issue comment"],
  ["release", "Release"],
  ["create", "Create"],
  ["delete", "Delete"],
  ["fork", "Fork"],
  ["watch", "Star"],
  ["pull_request_review", "PR review"],
  ["pull_request_review_comment", "PR review comment"],
];

export const SLACK_LISTENER_MATCHES: Array<[SlackListenerMatch, string]> = [
  ["mention", "Mention"],
  ["keyword", "Keyword"],
  ["message", "Any message"],
];

export const DISCORD_LISTENER_MATCHES: Array<[DiscordListenerMatch, string]> = [
  ["mention", "Mention"],
  ["dm", "DM"],
  ["channel", "Channel message"],
  ["keyword", "Keyword"],
  ["reaction", "Reaction"],
  ["thread", "Thread message"],
];

export type RoutineFormKind = "interval" | "daily" | "github" | "slack" | "discord" | "group";

function discordHow(schedule: Extract<RoutineSchedule, { kind: "listener"; source: "discord" }>): string {
  switch (schedule.match) {
    case "mention":
      return "mention";
    case "dm":
      return "DM";
    case "channel":
      return schedule.channel ? `channel message in ${schedule.channel}` : "channel message";
    case "keyword":
      return schedule.keyword ? `keyword: ${schedule.keyword}` : "keyword";
    case "reaction":
      return schedule.emoji ? `reaction ${schedule.emoji}` : "reaction";
    case "thread":
      return schedule.channel ? `thread message in ${schedule.channel}` : "thread message";
    default:
      return "match";
  }
}

function listenerLabel(schedule: ListenerSchedule): string {
  if (schedule.source === "github") {
    const repo = schedule.repo ? `${schedule.repo.owner}/${schedule.repo.name}` : "repo";
    const events = schedule.events?.length ? schedule.events.join(", ") : "events";
    return `GitHub ${repo} (${events})`;
  }
  if (schedule.source === "discord") return `Discord ${discordHow(schedule)}`;
  const where = schedule.channel ?? "channel";
  const how = schedule.match === "keyword" && schedule.keyword ? `keyword: ${schedule.keyword}` : (schedule.match ?? "match");
  return `Slack ${where} (${how})`;
}

export function scheduleLabel(schedule: RoutineSchedule): string {
  if (schedule.kind === "daily") return `Daily at ${schedule.time}${schedule.timeZone ? ` (${schedule.timeZone})` : ""}`;
  if (schedule.kind === "weekdays") return `Weekdays at ${schedule.time}${schedule.timeZone ? ` (${schedule.timeZone})` : ""}`;
  if (schedule.kind === "group") {
    if (!schedule.anyOf.length) return "Any of: (none)";
    return `Any of: ${schedule.anyOf.map(listenerLabel).join("; ")}`;
  }
  if (schedule.kind === "listener") return listenerLabel(schedule);
  return `Every ${schedule.everyMinutes} min`;
}

export function formKindFromSchedule(schedule: RoutineSchedule): RoutineFormKind {
  if (schedule.kind === "group") return "group";
  if (schedule.kind === "listener") return schedule.source;
  return schedule.kind === "daily" || schedule.kind === "weekdays" ? "daily" : "interval";
}

export function isEventDrivenSchedule(schedule: RoutineSchedule): boolean {
  if (schedule.kind === "listener") return schedule.source === "discord";
  if (schedule.kind === "group") return schedule.anyOf.every((child) => child.source === "discord");
  return false;
}

export function listenerScheduleFromForm(input: {
  kind: RoutineFormKind;
  everyMinutes: number;
  time: string;
  timeZone?: string;
  repoOwner: string;
  repoName: string;
  events: GithubListenerEvent[];
  channel: string;
  match: SlackListenerMatch | DiscordListenerMatch | "";
  keyword: string;
  emoji?: string;
  anyOf?: ListenerSchedule[];
}): RoutineSchedule {
  if (input.kind === "daily") {
    return { kind: "daily", time: input.time.slice(0, 5), ...(input.timeZone ? { timeZone: input.timeZone } : {}) };
  }
  if (input.kind === "github") {
    return {
      kind: "listener",
      source: "github",
      everyMinutes: input.everyMinutes,
      repo: { owner: input.repoOwner.trim(), name: input.repoName.trim() },
      events: input.events,
    };
  }
  if (input.kind === "slack") {
    return {
      kind: "listener",
      source: "slack",
      everyMinutes: input.everyMinutes,
      channel: input.channel.trim(),
      match: (input.match || "message") as SlackListenerMatch,
      ...(input.match === "keyword" && input.keyword.trim() ? { keyword: input.keyword.trim() } : {}),
    };
  }
  if (input.kind === "discord") {
    const match = (input.match || "channel") as DiscordListenerMatch;
    return {
      kind: "listener",
      source: "discord",
      match,
      ...(input.channel.trim() ? { channel: input.channel.trim() } : {}),
      ...(match === "keyword" && input.keyword.trim() ? { keyword: input.keyword.trim() } : {}),
      ...(match === "reaction" && input.emoji?.trim() ? { emoji: input.emoji.trim() } : {}),
    };
  }
  if (input.kind === "group") {
    return {
      kind: "group",
      anyOf: input.anyOf ?? [],
      everyMinutes: input.everyMinutes,
    };
  }
  return { kind: "interval", everyMinutes: input.everyMinutes };
}
