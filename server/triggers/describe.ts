// Human-readable descriptions for each trigger kind.
import type { RoutineTrigger } from "./contracts.ts";

function githubRepo(trigger: Extract<RoutineTrigger, { kind: "github" }>): string {
  return trigger.repo ? `${trigger.repo.owner}/${trigger.repo.name}` : "repo";
}

function githubEvents(trigger: Extract<RoutineTrigger, { kind: "github" }>): string {
  return trigger.events?.length ? trigger.events.join(", ") : "events";
}

function slackWhere(trigger: Extract<RoutineTrigger, { kind: "slack" }>): string {
  return trigger.channel ?? "channel";
}

function slackHow(trigger: Extract<RoutineTrigger, { kind: "slack" }>): string {
  if (trigger.match === "keyword" && trigger.keyword) return `keyword: ${trigger.keyword}`;
  return trigger.match ?? "match";
}

function discordHow(trigger: Extract<RoutineTrigger, { kind: "discord" }>): string {
  switch (trigger.match) {
    case "mention":
      return "mention";
    case "dm":
      return "DM";
    case "channel":
      return trigger.channel ? `channel message in ${trigger.channel}` : "channel message";
    case "keyword":
      return trigger.keyword ? `keyword: ${trigger.keyword}` : "keyword";
    case "reaction":
      return trigger.emoji ? `reaction ${trigger.emoji}` : "reaction";
    case "thread":
      return trigger.channel ? `thread message in ${trigger.channel}` : "thread message";
  }
}

/** One sentence (or short phrase) a human can read in the Routines panel. */
export function describeTrigger(trigger: RoutineTrigger): string {
  switch (trigger.kind) {
    case "cron":
      if (trigger.clock === "interval") return `Every ${trigger.everyMinutes} min`;
      if (trigger.clock === "weekdays") {
        return `Weekdays at ${trigger.time}${trigger.timeZone ? ` (${trigger.timeZone})` : ""}`;
      }
      return `Daily at ${trigger.time}${trigger.timeZone ? ` (${trigger.timeZone})` : ""}`;
    case "github":
      return `GitHub ${githubRepo(trigger)} (${githubEvents(trigger)})`;
    case "slack":
      return `Slack ${slackWhere(trigger)} (${slackHow(trigger)})`;
    case "discord":
      return `Discord ${discordHow(trigger)}`;
    case "group":
      if (!trigger.anyOf.length) return "Any of: (none)";
      return `Any of: ${trigger.anyOf.map(describeTrigger).join("; ")}`;
  }
}
