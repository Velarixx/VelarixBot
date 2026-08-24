// Parse / reject the trigger union. Accepts both first-class trigger
// shapes ({ kind: "discord" | "github" | … }) and the persisted schedule
// shapes (interval / daily / weekdays / listener / group).
import {
  parseDiscordEmoji,
  parseDiscordMatch,
  parseGithubListenerEvents,
  parseGithubRepo,
  parseGithubRepoField,
  parseSlackChannel,
  parseSlackMatch,
} from "../store.ts";
import { isValidTimeZone } from "../timezone.ts";
import type {
  CronTrigger,
  DiscordTrigger,
  GithubTrigger,
  GroupTrigger,
  ListenerTrigger,
  ParseTriggerOpts,
  RoutineTrigger,
  SlackTrigger,
} from "./contracts.ts";

export { parseDiscordEmoji, parseDiscordMatch };

const MAX_GROUP_CHILDREN = 8;

export function parseDiscordChannel(raw: unknown): string | null {
  return parseSlackChannel(raw);
}

function parseEveryMinutes(raw: unknown, fallback = 15): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseCronTrigger(s: Record<string, unknown>, opts: ParseTriggerOpts): CronTrigger {
  if (s.clock === "interval" || s.kind === "interval" || (s.clock !== "daily" && s.clock !== "weekdays" && s.everyMinutes != null && s.time == null)) {
    const everyMinutes = Number(s.everyMinutes);
    if (!Number.isFinite(everyMinutes) || everyMinutes <= 0) throw new Error("invalid interval");
    return { kind: "cron", clock: "interval", everyMinutes };
  }
  const time = String(s.time ?? "").slice(0, 5);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error("invalid daily time");
  let timeZone: string | undefined;
  if (s.timeZone !== undefined && s.timeZone !== null && s.timeZone !== "") {
    if (isValidTimeZone(s.timeZone)) timeZone = s.timeZone;
    else if (opts.strictTimeZone || opts.strict) throw new Error("invalid time zone");
  }
  const weekdays = s.clock === "weekdays" || s.kind === "weekdays";
  return { kind: "cron", clock: weekdays ? "weekdays" : "daily", time, ...(timeZone ? { timeZone } : {}) };
}

function parseGithubTrigger(s: Record<string, unknown>, strict: boolean): GithubTrigger {
  const repo =
    parseGithubRepoField(s.repo) ??
    parseGithubRepo(s.owner ?? (s.repo as { owner?: unknown } | undefined)?.owner, s.name ?? (s.repo as { name?: unknown } | undefined)?.name);
  const events = parseGithubListenerEvents(s.events);
  if (strict && !repo) throw new Error("github listener needs one owner/name repo");
  if (strict && !events.length) throw new Error("github listener needs an explicit event allow-list");
  const every = parseEveryMinutes(s.everyMinutes);
  return {
    kind: "github",
    everyMinutes: every,
    ...(repo ? { repo } : {}),
    ...(events.length ? { events } : {}),
  };
}

function parseSlackTrigger(s: Record<string, unknown>, strict: boolean): SlackTrigger {
  const channel = parseSlackChannel(s.channel);
  const match = parseSlackMatch(s.match);
  const keyword = String(s.keyword ?? "").trim();
  if (strict && !channel) throw new Error("slack listener needs a channel or DM");
  if (strict && !match) throw new Error("slack listener needs match: mention, keyword, or message");
  if (strict && match === "keyword" && !keyword) throw new Error("slack keyword match needs a keyword");
  return {
    kind: "slack",
    everyMinutes: parseEveryMinutes(s.everyMinutes),
    ...(channel ? { channel } : {}),
    ...(match ? { match } : {}),
    ...(match === "keyword" && keyword ? { keyword } : {}),
  };
}

function parseDiscordTrigger(s: Record<string, unknown>, strict: boolean): DiscordTrigger {
  const match = parseDiscordMatch(s.match);
  if (strict && !match) throw new Error("discord trigger needs match: mention, dm, channel, keyword, reaction, or thread");
  const channel = parseDiscordChannel(s.channel);
  const keyword = String(s.keyword ?? "").trim();
  const emoji = parseDiscordEmoji(s.emoji);
  if (strict && match === "keyword" && !keyword) throw new Error("discord keyword match needs a keyword");
  const resolved = match ?? "channel";
  return {
    kind: "discord",
    match: resolved,
    ...(channel ? { channel } : {}),
    ...(resolved === "keyword" && keyword ? { keyword } : {}),
    ...(resolved === "reaction" && emoji ? { emoji } : {}),
  };
}

function parseListenerTrigger(s: Record<string, unknown>, strict: boolean): ListenerTrigger {
  const source = s.kind === "github" || s.kind === "slack" || s.kind === "discord" ? s.kind : s.source;
  if (source === "github") return parseGithubTrigger(s, strict);
  if (source === "slack") return parseSlackTrigger(s, strict);
  if (source === "discord") return parseDiscordTrigger(s, strict);
  throw new Error("listener must be github, slack, or discord");
}

function parseGroupTrigger(s: Record<string, unknown>, opts: ParseTriggerOpts, depth: number): GroupTrigger {
  if (depth > 2) throw new Error("grouped trigger cannot nest another group");
  const raw = s.anyOf ?? s.triggers ?? s.listeners;
  if (!Array.isArray(raw)) throw new Error("grouped trigger needs anyOf: an array of listeners");
  if (raw.length < 1) throw new Error("grouped trigger needs at least one listener");
  if (raw.length > MAX_GROUP_CHILDREN) throw new Error(`grouped trigger is capped at ${MAX_GROUP_CHILDREN} listeners`);
  const anyOf: ListenerTrigger[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") throw new Error("grouped trigger children must be listeners");
    const child = item as Record<string, unknown>;
    const kind = String(child.kind ?? "");
    if (kind === "group" || kind === "cron" || kind === "interval" || kind === "daily" || kind === "weekdays") {
      throw new Error("grouped trigger children must be github, slack, or discord listeners");
    }
    anyOf.push(parseListenerTrigger(child, opts.strict === true));
  }
  return {
    kind: "group",
    anyOf,
    everyMinutes: parseEveryMinutes(s.everyMinutes),
  };
}

/** Parse a trigger or a persisted schedule. Throws on an invalid union. */
export function parseRoutineTrigger(raw: unknown, opts: ParseTriggerOpts = {}): RoutineTrigger {
  if (!raw || typeof raw !== "object") throw new Error("trigger required");
  const s = raw as Record<string, unknown>;
  const kind = String(s.kind ?? "");
  if (kind === "group") return parseGroupTrigger(s, opts, 0);
  if (kind === "github" || (kind === "listener" && s.source === "github")) return parseGithubTrigger(s, opts.strict === true);
  if (kind === "slack" || (kind === "listener" && s.source === "slack")) return parseSlackTrigger(s, opts.strict === true);
  if (kind === "discord" || (kind === "listener" && s.source === "discord")) return parseDiscordTrigger(s, opts.strict === true);
  if (kind === "listener") throw new Error("listener must be github, slack, or discord");
  if (kind === "cron" || kind === "interval" || kind === "daily" || kind === "weekdays") {
    return parseCronTrigger(s, opts);
  }
  throw new Error("trigger must be cron, github, slack, discord, or group");
}

export function triggerFilterComplete(trigger: RoutineTrigger): boolean {
  switch (trigger.kind) {
    case "cron":
      return true;
    case "github":
      return Boolean(trigger.repo?.owner && trigger.repo?.name && trigger.events?.length);
    case "slack":
      if (trigger.match === "keyword") return Boolean(trigger.channel && trigger.keyword?.trim());
      return Boolean(trigger.channel && trigger.match);
    case "discord":
      if (trigger.match === "keyword") return Boolean(trigger.keyword?.trim());
      return Boolean(trigger.match);
    case "group":
      return trigger.anyOf.length > 0 && trigger.anyOf.every(triggerFilterComplete);
  }
}
