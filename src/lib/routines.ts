// Routine schedule labels + create/edit payload helpers for RoutinesPanel.
import type { GithubListenerEvent, RoutineSchedule, SlackListenerMatch } from "@/state/store";

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

export type RoutineFormKind = "interval" | "daily" | "github" | "slack";

export function scheduleLabel(schedule: RoutineSchedule): string {
  if (schedule.kind === "daily") return `Daily at ${schedule.time}${schedule.timeZone ? ` (${schedule.timeZone})` : ""}`;
  if (schedule.kind === "weekdays") return `Weekdays at ${schedule.time}${schedule.timeZone ? ` (${schedule.timeZone})` : ""}`;
  if (schedule.kind === "listener") {
    if (schedule.source === "github") {
      const repo = schedule.repo ? `${schedule.repo.owner}/${schedule.repo.name}` : "repo";
      const events = schedule.events?.length ? schedule.events.join(", ") : "events";
      return `github ${repo} (${events})`;
    }
    const where = schedule.channel ?? "channel";
    const how = schedule.match === "keyword" && schedule.keyword ? `keyword: ${schedule.keyword}` : (schedule.match ?? "match");
    return `slack ${where} (${how})`;
  }
  return `Every ${schedule.everyMinutes} min`;
}

export function formKindFromSchedule(schedule: RoutineSchedule): RoutineFormKind {
  if (schedule.kind === "listener") return schedule.source;
  return schedule.kind === "daily" || schedule.kind === "weekdays" ? "daily" : "interval";
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
  match: SlackListenerMatch | "";
  keyword: string;
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
  return { kind: "interval", everyMinutes: input.everyMinutes };
}
