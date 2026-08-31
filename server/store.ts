// Domain records + validation for the workspace store. Persistence lives in
// SQLite behind server/repositories/ (see server/db/); this module owns the
// shapes and the normalization every reader/importer shares, so a record
// written by any past version of the app loads into a valid current record.
import { normalizeComputerBinding } from "./computer/provider.ts";
import type { ModelSelection, ThreadId } from "./contracts.ts";
import { isValidTimeZone, zonedNextClockRun } from "./timezone.ts";
import {
  isWorkflowStatus,
  validWaitingFor,
  type WorkflowStatus,
  type WorkflowWaitingFor,
} from "./workflow.ts";

const BLOB_HASH_RE = /^[0-9a-f]{64}$/;
function validStoredHash(v: unknown): v is string {
  return typeof v === "string" && BLOB_HASH_RE.test(v);
}
function validStoredHashList(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((h): h is string => validStoredHash(h));
  return out.length ? out : undefined;
}

export type MausColor = "green" | "blue" | "red" | "orange" | "purple" | "cyan" | "pink" | "yellow" | "teal" | "coral";
export type MausExpression = string;
export const ICON_SHAPES = ["cursor", "blob", "circle", "squircle", "diamond", "hexagon", "teardrop", "shield"] as const;
export type IconShape = (typeof ICON_SHAPES)[number];
export function resolveIconShape(value: unknown): IconShape {
  return ICON_SHAPES.includes(value as IconShape) ? (value as IconShape) : "cursor";
}
/** Product rule: the workspace always keeps at least one bot (Chief of Staff / last bot). */
export const LAST_BOT_ERROR = "cannot delete the last bot";
export function wouldEmptyWorkspace(botCount: number): boolean {
  return botCount <= 1;
}
export type BotState = "IDLE" | "RUNNING" | "DONE" | "BLOCKED" | "NEEDS_INPUT";
export interface Usage { input: number; output: number; cost: number | null }
export interface OptionCardData {
  title: string;
  subtitle: string;
  options: string[];
  answered?: string;
  dismissed?: boolean;
  requestId?: string;
  requestType?: "permission" | "question" | "credential" | "secret" | "suggestion" | "setup";
  connectUrl?: string;
  /** PRO extract card. Accept writes via createRoutine / insertMemoryRow. */
  suggestion?: { botId: string; type: "preference" | "fact" | "workflow"; text: string };
}
export interface MessageFrom {
  botId: string;
  name: string;
  color?: MausColor;
}
export interface MessageComm {
  groupId: string;
  withBotId: string;
  withName: string;
  withColor?: MausColor;
}
export const MESSAGE_REPORT_KINDS = ["progress", "blocker", "completion", "handoff"] as const;
export type MessageReportKind = (typeof MESSAGE_REPORT_KINDS)[number];
export const MESSAGE_REPORT_STATUSES = ["pending", "terminal", "failed", "delivery_failed"] as const;
export type MessageReportStatus = (typeof MESSAGE_REPORT_STATUSES)[number];
export interface MessageReport {
  kind: MessageReportKind;
  fromBotId: string;
  taskId?: string;
  /** Additive #150: truthful settlement so stale progress cannot keep spinning. */
  status?: MessageReportStatus;
  failureCode?: string;
}
export interface Message {
  id: string; role: "bot" | "user"; kind: "text" | "options" | "activity" | "screen"; text?: string;
  card?: OptionCardData; tool?: { name: string; ok?: boolean; status?: "completed" | "failed" | "cancelled" | "timed_out"; command?: string }; png?: string; mime?: string; at: number; usage?: Usage;
  /** Paged hydration: a screen frame whose pixels live at the per-image fetch. */
  hasImage?: boolean;
  /** Sender on a bot⇄bot DM transcript. */
  from?: MessageFrom;
  /** Chip link from a 1:1 thread to the A ⇄ B channel. */
  comm?: MessageComm;
  /** Delegated-agent report in the lead feed (#119). */
  report?: MessageReport;
  /** Assignment / report link to a persisted agent task (#120). */
  task?: { id: string };
}
/** Sidebar DM (`Name ⇄ Name`) for ask_bot / delegate_bot visibility. Not a room/bulletin product. */
export interface GroupRecord {
  id: string;
  threadId: ThreadId;
  name: string;
  memberIds: string[];
  unread: boolean;
  createdAt: number;
  dm?: boolean;
}
export interface BotRecord {
  id: string; threadId: ThreadId; name: string; title: string; description: string; notifications: boolean; color: MausColor;
  mascotExpression?: MausExpression | null; iconShape?: IconShape; unread: boolean; modelSelection: ModelSelection; resumeCursors: Record<string, unknown>;
  /** M1: true only when the user explicitly picked a face; false when the
   * stored expression came from the A1 seed (re-roll) and must not mask the
   * live BotState face. Missing on pre-flag records — the client keeps the
   * historical "any stored expression pins" behavior for those. */
  mascotPinned?: boolean;
  /** A1 seeded procedural avatar: the re-roll counter. The face is always
   * `seedAvatar({ botId, nonce })` (server/avatar-seed.ts) — persisting the
   * nonce means the same face regenerates after any reload or PATCH
   * round-trip, with zero keys and zero raster storage. */
  avatarNonce?: number;
  /** A2 accepted raster: sha256 of bytes in ~/.velarixbot/blobs/<hash>.
   * Missing/null = vector mascot fallback. Never store image bytes here. */
  avatarImageHash?: string | null;
  /** Last generate batch (hashes only). Lets the picker survive a reload
   * and keeps screenshot GC from deleting unused candidates. */
  avatarCandidates?: string[];
  /** Computer provider BINDING: "off", "local", or a configured provider id
   * (e.g. "box"). Legacy "cloud" records normalize to "box". A binding to a
   * provider that is no longer configured stays on the record and simply
   * resolves to nothing at runtime. */
  computer: string; pinned?: boolean; hidden?: boolean; busy: boolean; state: BotState; stateDetail?: string;
  /** Machine-readable block/stop code (spawn_error, no_engines, …). Never
   * copy this into user-facing stateDetail — ChatView renders stateDetail. */
  stateCode?: string;
  usage: Usage; currentTurnUsage?: Usage; createdAt: number; requireApproval?: boolean;
  /** Bot Settings → Permissions → Always allow: routine permission asks for
   * THIS bot auto-resolve to allow without a card. Scoped to this bot only —
   * never a workspace rule, never a stored `*` matcher. Credential/sign-in
   * asks still card, and Require approval wins when both are set. */
  alwaysAllow?: boolean;
  /** Connected-app slugs this bot may use (Composio). Empty/missing = none. */
  enabledApps?: string[];
  /** Taught skills this bot injects on every turn. Library is cross-bot;
   * this list is the per-bot enable set (same shape as enabledApps). */
  enabledSkills?: string[];
  /** Bitwarden secret ids this bot may receive at execution time. Empty = none. */
  bitwardenSecretIds?: string[];
  /** Bitwarden project ids this bot may receive secrets from. Empty = none. */
  bitwardenProjectIds?: string[];
  /** Legacy single attach. Empty enabledSkills + skillId set → [skillId]. */
  skillId?: string;
  /** Per-event notification overrides. Missing keys default on when `notifications` is on. */
  notifyEvents?: Partial<Record<"request.opened" | "turn.completed" | "stall.nudge" | "peer.reply", boolean>>;
  /** Bots sharing this thread's transcript (group mention / ask_bot). */
  threadParticipants?: string[];
  /** User-controlled full-autonomy setting. Missing/false = off (never an implicit default). */
  fullAutonomy?: boolean;
  /** Explicit lead-chat workflow chip (#116). Independent of BotState. */
  workflowStatus?: WorkflowStatus;
  workflowWaitingFor?: WorkflowWaitingFor[];
  /** Why autonomous execution stopped (or why the lead is idle after a wave). */
  workflowStopReason?: string;
  /** Autonomous continue hops in the current user-started wave. */
  workflowAutonomyHops?: number;
  /** First-class Conversations section. Missing/null = Unassigned.
   * Title is a personality field and is never used as a section key. */
  sectionId?: string | null;
}
/** Explicit GitHub Events API allow-list. No wildcard, no implied *. */
export const GITHUB_LISTENER_EVENTS = [
  "push",
  "pull_request",
  "issues",
  "issue_comment",
  "release",
  "create",
  "delete",
  "fork",
  "watch",
  "pull_request_review",
  "pull_request_review_comment",
] as const;
export type GithubListenerEvent = (typeof GITHUB_LISTENER_EVENTS)[number];
export const SLACK_LISTENER_MATCHES = ["mention", "keyword", "message"] as const;
export type SlackListenerMatch = (typeof SLACK_LISTENER_MATCHES)[number];
export const DISCORD_LISTENER_MATCHES = ["mention", "dm", "channel", "keyword", "reaction", "thread"] as const;
export type DiscordListenerMatch = (typeof DISCORD_LISTENER_MATCHES)[number];
export type GithubListenerSchedule = {
  kind: "listener";
  source: "github";
  everyMinutes?: number;
  repo?: { owner: string; name: string };
  events?: GithubListenerEvent[];
};
export type SlackListenerSchedule = {
  kind: "listener";
  source: "slack";
  everyMinutes?: number;
  channel?: string;
  match?: SlackListenerMatch;
  keyword?: string;
};
export type DiscordListenerSchedule = {
  kind: "listener";
  source: "discord";
  everyMinutes?: number;
  match?: DiscordListenerMatch;
  channel?: string;
  keyword?: string;
  emoji?: string;
};
export type ListenerSchedule = GithubListenerSchedule | SlackListenerSchedule | DiscordListenerSchedule;
export type GroupSchedule = {
  kind: "group";
  anyOf: ListenerSchedule[];
  everyMinutes?: number;
};
export type RoutineSchedule =
  | { kind: "interval"; everyMinutes: number }
  | { kind: "daily"; time: string; timeZone?: string }
  | { kind: "weekdays"; time: string; timeZone?: string }
  | GithubListenerSchedule
  | SlackListenerSchedule
  | DiscordListenerSchedule
  | GroupSchedule;
export interface ThenStartTurn { botId: string; prompt: string }
/** What the scheduler does with occurrences that came due while VelarixBot
 * was closed or asleep: drop them (skip), coalesce them into one run
 * (run-once — the historical behavior and the default), or run each missed
 * occurrence in order (catch-up). */
export type MissedPolicy = "skip" | "run-once" | "catch-up";
export const MISSED_POLICIES: MissedPolicy[] = ["skip", "run-once", "catch-up"];
export function parseMissedPolicy(v: unknown): MissedPolicy | null {
  return MISSED_POLICIES.includes(v as MissedPolicy) ? (v as MissedPolicy) : null;
}
export interface RoutineRecord {
  id: string; botId: string; name: string; prompt: string; schedule: RoutineSchedule; enabled: boolean; running: boolean;
  nextRunAt: number; lastRunAt: number | null; lastResult: string | null; createdAt: number;
  missedPolicy: MissedPolicy;
  thenStartTurn?: ThenStartTurn;
  skillId?: string;
  /** Last seen GitHub event id or Slack message ts. Per-routine poll cursor. */
  listenerCursor?: string;
}

export const COLORS: MausColor[] = ["green", "blue", "red", "orange", "purple", "cyan", "pink", "yellow", "teal", "coral"];
export const STATES = new Set<BotState>(["IDLE", "RUNNING", "DONE", "BLOCKED", "NEEDS_INPUT"]);
/** Bindings that exist without any provider registry (the registry adds
 * configured provider ids on top). Used only as the validation fallback. */
export const BASE_COMPUTER_BINDINGS = ["local", "box"];
export const zeroUsage = (): Usage => ({ input: 0, output: 0, cost: null });

export function validUsage(v: unknown): Usage {
  const x = v as Partial<Usage> | null;
  return { input: Number.isFinite(x?.input) ? Math.max(0, Number(x!.input)) : 0, output: Number.isFinite(x?.output) ? Math.max(0, Number(x!.output)) : 0, cost: Number.isFinite(x?.cost) ? Math.max(0, Number(x!.cost)) : null };
}

/** A modelSelection that survives a round-trip; damaged/missing selections
 * salvage to an empty binding so the bot stays visible and repairable in
 * the model picker (startTurn then fails loudly with "pick another model")
 * instead of the whole record vanishing from every read. */
export function validModelSelection(v: unknown): ModelSelection | null {
  const s = v as Partial<ModelSelection> | null;
  if (!s || typeof s !== "object") return null;
  if (typeof s.instanceId !== "string" || typeof s.model !== "string") return null;
  const effort = typeof s.effort === "string" && s.effort.trim() ? s.effort.trim() : undefined;
  return { instanceId: s.instanceId, model: s.model, ...(effort ? { effort } : {}) };
}

/** Normalize any historical bot record into a valid current one; null ONLY
 * when unrecognizable (id/threadId missing). A record whose name or
 * modelSelection is damaged is salvaged with fallbacks — the rc.14 field
 * failure was a single bad field making the bot silently disappear from
 * every read (list_bots "no other bots", update_bot "no such bot") while
 * its row still existed. `recoverInterrupted` flips a crashed RUNNING/busy
 * record to BLOCKED/interrupted — boot-time recovery only, never on a live
 * read (a live read of a RUNNING bot must stay RUNNING). */
export function normalizeBot(v: unknown, opts: { recoverInterrupted?: boolean } = {}): BotRecord | null {
  if (!v || typeof v !== "object") return null;
  const b = v as Partial<BotRecord>;
  if (typeof b.id !== "string" || !b.id || typeof b.threadId !== "string" || !b.threadId) return null;
  const crashed = opts.recoverInterrupted === true && (b.state === "RUNNING" || b.busy === true);
  return {
    id: b.id, threadId: b.threadId,
    name: typeof b.name === "string" ? b.name : "New Bot",
    title: typeof b.title === "string" ? b.title : "", description: typeof b.description === "string" ? b.description : "",
    notifications: b.notifications !== false, color: COLORS.includes(b.color as MausColor) ? b.color! : "blue", mascotExpression: b.mascotExpression,
    iconShape: resolveIconShape(b.iconShape),
    unread: b.unread === true, modelSelection: validModelSelection(b.modelSelection) ?? { instanceId: "", model: "" }, resumeCursors: b.resumeCursors && typeof b.resumeCursors === "object" ? b.resumeCursors : {},
    computer: normalizeComputerBinding(b.computer), pinned: b.pinned, hidden: b.hidden, busy: crashed ? false : b.busy === true,
    state: crashed ? "BLOCKED" : STATES.has(b.state as BotState) ? b.state! : "IDLE", ...(crashed ? { stateDetail: "interrupted" } : b.stateDetail ? { stateDetail: b.stateDetail } : {}),
    ...(crashed ? {} : typeof b.stateCode === "string" && b.stateCode ? { stateCode: b.stateCode } : {}),
    usage: validUsage(b.usage), currentTurnUsage: b.currentTurnUsage ? validUsage(b.currentTurnUsage) : undefined, createdAt: Number.isFinite(b.createdAt) ? b.createdAt! : Date.now(),
    ...(typeof b.avatarNonce === "number" && Number.isInteger(b.avatarNonce) && b.avatarNonce >= 0 ? { avatarNonce: b.avatarNonce } : {}),
    ...(validStoredHash(b.avatarImageHash) ? { avatarImageHash: b.avatarImageHash } : {}),
    ...(validStoredHashList(b.avatarCandidates) ? { avatarCandidates: validStoredHashList(b.avatarCandidates) } : {}),
    ...(typeof b.mascotPinned === "boolean" ? { mascotPinned: b.mascotPinned } : {}),
    ...(b.requireApproval === true ? { requireApproval: true } : {}),
    ...(b.alwaysAllow === true ? { alwaysAllow: true } : {}),
    ...(validStringList(b.enabledApps) ? { enabledApps: validStringList(b.enabledApps) } : {}),
    ...(validStringList(b.enabledSkills) ? { enabledSkills: validStringList(b.enabledSkills) } : {}),
    ...(validStringList(b.bitwardenSecretIds) ? { bitwardenSecretIds: validStringList(b.bitwardenSecretIds) } : {}),
    ...(validStringList(b.bitwardenProjectIds) ? { bitwardenProjectIds: validStringList(b.bitwardenProjectIds) } : {}),
    ...(typeof b.skillId === "string" && b.skillId.trim() ? { skillId: b.skillId.trim() } : {}),
    ...(validNotifyEvents(b.notifyEvents) ? { notifyEvents: validNotifyEvents(b.notifyEvents) } : {}),
    ...(validStringList(b.threadParticipants) ? { threadParticipants: validStringList(b.threadParticipants) } : {}),
    ...(b.fullAutonomy === true ? { fullAutonomy: true } : {}),
    ...(isWorkflowStatus(b.workflowStatus) ? { workflowStatus: b.workflowStatus } : {}),
    ...(validWaitingFor(b.workflowWaitingFor)?.length ? { workflowWaitingFor: validWaitingFor(b.workflowWaitingFor) } : {}),
    ...(typeof b.workflowStopReason === "string" && b.workflowStopReason.trim()
      ? { workflowStopReason: b.workflowStopReason.trim() }
      : {}),
    ...(typeof b.workflowAutonomyHops === "number" && Number.isFinite(b.workflowAutonomyHops) && b.workflowAutonomyHops > 0
      ? { workflowAutonomyHops: Math.floor(b.workflowAutonomyHops) }
      : {}),
    ...(typeof b.sectionId === "string" && b.sectionId.trim() ? { sectionId: b.sectionId.trim() } : {}),
  };
}

export function nextRunAt(schedule: RoutineSchedule, from = Date.now()): number {
  if (schedule.kind === "interval") {
    if (!Number.isFinite(schedule.everyMinutes) || schedule.everyMinutes <= 0) throw new Error("invalid interval");
    return from + schedule.everyMinutes * 60_000;
  }
  if (schedule.kind === "listener" || schedule.kind === "group") {
    const every = Number.isFinite(schedule.everyMinutes) && (schedule.everyMinutes ?? 0) > 0 ? schedule.everyMinutes! : 15;
    return from + every * 60_000;
  }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.time)) throw new Error("invalid daily time");
  const [h, m] = schedule.time.split(":").map(Number);
  const weekdaysOnly = schedule.kind === "weekdays";
  // explicit-zone schedules resolve wall time (and DST) in their stored
  // zone; legacy records without a zone keep the process-local behavior
  if (schedule.timeZone) return zonedNextClockRun(schedule.timeZone, schedule.time, weekdaysOnly, from);
  const d = new Date(from);
  d.setHours(h, m, 0, 0);
  for (let i = 0; i < 8; i++) {
    const t = d.getTime();
    const day = d.getDay();
    const weekday = day >= 1 && day <= 5;
    if (t > from && (!weekdaysOnly || weekday)) return t;
    d.setDate(d.getDate() + 1);
  }
  throw new Error("invalid clock schedule");
}

const GITHUB_EVENT_SET = new Set<string>(GITHUB_LISTENER_EVENTS);
const SLACK_MATCH_SET = new Set<string>(SLACK_LISTENER_MATCHES);
const DISCORD_MATCH_SET = new Set<string>(DISCORD_LISTENER_MATCHES);
const GITHUB_NAME_RE = /^[A-Za-z0-9._][A-Za-z0-9._-]{0,99}$/;
const GITHUB_OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

export function parseGithubRepo(ownerRaw: unknown, nameRaw: unknown): { owner: string; name: string } | null {
  const owner = String(ownerRaw ?? "").trim();
  const name = String(nameRaw ?? "").trim();
  if (!owner || !name) return null;
  if (owner === "*" || name === "*" || owner.includes("/") || name.includes("/")) return null;
  if (owner === "." || owner === ".." || name === "." || name === "..") return null;
  if (!GITHUB_OWNER_RE.test(owner) || !GITHUB_NAME_RE.test(name)) return null;
  return { owner, name };
}

/** Accept `owner/name` or `{ owner, name }`. One concrete repo, never a wildcard. */
export function parseGithubRepoField(raw: unknown): { owner: string; name: string } | null {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    const slash = trimmed.indexOf("/");
    if (slash <= 0 || slash !== trimmed.lastIndexOf("/")) return null;
    return parseGithubRepo(trimmed.slice(0, slash), trimmed.slice(slash + 1));
  }
  if (raw && typeof raw === "object") {
    const o = raw as { owner?: unknown; name?: unknown };
    return parseGithubRepo(o.owner, o.name);
  }
  return null;
}

export function parseGithubListenerEvents(raw: unknown): GithubListenerEvent[] {
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === "string"
      ? raw.split(/[,\s]+/)
      : [];
  const out: GithubListenerEvent[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const key = String(item ?? "").trim().toLowerCase();
    if (!GITHUB_EVENT_SET.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(key as GithubListenerEvent);
  }
  return out;
}

export function parseSlackChannel(raw: unknown): string | null {
  const channel = String(raw ?? "").trim();
  if (!channel || channel === "*" || /^all$/i.test(channel)) return null;
  if (channel.length > 80) return null;
  return channel;
}

export function parseSlackMatch(raw: unknown): SlackListenerMatch | null {
  const match = String(raw ?? "").trim().toLowerCase();
  return SLACK_MATCH_SET.has(match) ? (match as SlackListenerMatch) : null;
}

export function parseDiscordMatch(raw: unknown): DiscordListenerMatch | null {
  const match = String(raw ?? "").trim().toLowerCase();
  return DISCORD_MATCH_SET.has(match) ? (match as DiscordListenerMatch) : null;
}

export function parseDiscordEmoji(raw: unknown): string | null {
  const emoji = String(raw ?? "").trim();
  if (!emoji || emoji.length > 64) return null;
  return emoji;
}

/** MCP / form args → a complete listener schedule, or a reason it isn't. */
export function listenerScheduleFromArgs(
  source: "github" | "slack" | "discord",
  args: Record<string, unknown>,
  everyMinutes: number,
): { schedule: RoutineSchedule } | { error: string } {
  try {
    const schedule = parseRoutineSchedule(
      {
        kind: "listener",
        source,
        everyMinutes,
        repo: args.repo ?? { owner: args.repo_owner, name: args.repo_name },
        owner: args.repo_owner,
        name: args.repo_name,
        events: args.events,
        channel: args.channel,
        match: args.match,
        keyword: args.keyword,
        emoji: args.emoji,
      },
      { strictListener: true },
    );
    return { schedule };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

export function listenerFilterComplete(schedule: RoutineSchedule): boolean {
  if (schedule.kind === "group") {
    return schedule.anyOf.length > 0 && schedule.anyOf.every(listenerFilterComplete);
  }
  if (schedule.kind !== "listener") return true;
  if (schedule.source === "github") {
    return Boolean(schedule.repo?.owner && schedule.repo?.name && schedule.events?.length);
  }
  if (schedule.source === "discord") {
    if (schedule.match === "keyword") return Boolean(schedule.keyword?.trim());
    return Boolean(schedule.match);
  }
  if (schedule.match === "keyword") return Boolean(schedule.channel && schedule.keyword?.trim());
  return Boolean(schedule.channel && schedule.match);
}

function parseListenerSchedule(s: Record<string, unknown>, strict: boolean): ListenerSchedule {
  const source =
    s.source === "slack" || s.kind === "slack"
      ? "slack"
      : s.source === "discord" || s.kind === "discord"
        ? "discord"
        : s.source === "github" || s.kind === "github"
          ? "github"
          : "";
  if (source !== "github" && source !== "slack" && source !== "discord") {
    throw new Error("listener must be github, slack, or discord");
  }
  const everyMinutes = Number(s.everyMinutes);
  const every = Number.isFinite(everyMinutes) && everyMinutes > 0 ? everyMinutes : 15;
  if (source === "github") {
    const repo = parseGithubRepoField(s.repo) ?? parseGithubRepo(s.owner ?? (s.repo as { owner?: unknown } | undefined)?.owner, s.name ?? (s.repo as { name?: unknown } | undefined)?.name);
    const events = parseGithubListenerEvents(s.events);
    if (strict && !repo) throw new Error("github listener needs one owner/name repo");
    if (strict && !events.length) throw new Error("github listener needs an explicit event allow-list");
    return {
      kind: "listener",
      source: "github",
      everyMinutes: every,
      ...(repo ? { repo } : {}),
      ...(events.length ? { events } : {}),
    };
  }
  if (source === "discord") {
    const match = parseDiscordMatch(s.match);
    const channel = parseSlackChannel(s.channel);
    const keyword = String(s.keyword ?? "").trim();
    const emoji = parseDiscordEmoji(s.emoji);
    if (strict && !match) throw new Error("discord trigger needs match: mention, dm, channel, keyword, reaction, or thread");
    if (strict && match === "keyword" && !keyword) throw new Error("discord keyword match needs a keyword");
    return {
      kind: "listener",
      source: "discord",
      everyMinutes: every,
      ...(match ? { match } : {}),
      ...(channel ? { channel } : {}),
      ...(match === "keyword" && keyword ? { keyword } : {}),
      ...(match === "reaction" && emoji ? { emoji } : {}),
    };
  }
  const channel = parseSlackChannel(s.channel);
  const match = parseSlackMatch(s.match);
  const keyword = String(s.keyword ?? "").trim();
  if (strict && !channel) throw new Error("slack listener needs a channel or DM");
  if (strict && !match) throw new Error("slack listener needs match: mention, keyword, or message");
  if (strict && match === "keyword" && !keyword) throw new Error("slack keyword match needs a keyword");
  return {
    kind: "listener",
    source: "slack",
    everyMinutes: every,
    ...(channel ? { channel } : {}),
    ...(match ? { match } : {}),
    ...(match === "keyword" && keyword ? { keyword } : {}),
  };
}

const MAX_GROUP_CHILDREN = 8;

function parseGroupSchedule(s: Record<string, unknown>, opts: { strictTimeZone?: boolean; strictListener?: boolean }): GroupSchedule {
  const raw = s.anyOf ?? s.triggers ?? s.listeners;
  if (!Array.isArray(raw)) throw new Error("grouped trigger needs anyOf: an array of listeners");
  if (raw.length < 1) throw new Error("grouped trigger needs at least one listener");
  if (raw.length > MAX_GROUP_CHILDREN) throw new Error(`grouped trigger is capped at ${MAX_GROUP_CHILDREN} listeners`);
  const anyOf: ListenerSchedule[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") throw new Error("grouped trigger children must be listeners");
    const child = item as Record<string, unknown>;
    const kind = String(child.kind ?? "");
    if (kind === "group" || kind === "cron" || kind === "interval" || kind === "daily" || kind === "weekdays") {
      throw new Error("grouped trigger children must be github, slack, or discord listeners");
    }
    const parsed = parseListenerSchedule(child, opts.strictListener === true);
    anyOf.push(parsed);
  }
  const everyMinutes = Number(s.everyMinutes);
  const every = Number.isFinite(everyMinutes) && everyMinutes > 0 ? everyMinutes : 15;
  return { kind: "group", anyOf, everyMinutes: every };
}

export function parseRoutineSchedule(raw: unknown, opts: { strictTimeZone?: boolean; strictListener?: boolean } = {}): RoutineSchedule {
  if (!raw || typeof raw !== "object") throw new Error("schedule required");
  const s = raw as Record<string, unknown>;
  if (s.kind === "listener" || s.kind === "github" || s.kind === "slack" || s.kind === "discord") {
    return parseListenerSchedule(s, opts.strictListener === true);
  }
  if (s.kind === "group") return parseGroupSchedule(s, opts);
  if (s.kind === "cron") {
    if (s.clock === "interval" || (s.everyMinutes != null && s.time == null)) {
      const everyMinutes = Number(s.everyMinutes);
      if (!Number.isFinite(everyMinutes) || everyMinutes <= 0) throw new Error("invalid interval");
      return { kind: "interval", everyMinutes };
    }
    const clockKind = s.clock === "weekdays" ? "weekdays" : "daily";
    const time = String(s.time ?? "").slice(0, 5);
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error("invalid daily time");
    let timeZone: string | undefined;
    if (s.timeZone !== undefined && s.timeZone !== null && s.timeZone !== "") {
      if (isValidTimeZone(s.timeZone)) timeZone = s.timeZone;
      else if (opts.strictTimeZone) throw new Error("invalid time zone");
    }
    return { kind: clockKind, time, ...(timeZone ? { timeZone } : {}) };
  }
  if (s.kind === "interval") {
    const everyMinutes = Number(s.everyMinutes);
    if (!Number.isFinite(everyMinutes) || everyMinutes <= 0) throw new Error("invalid interval");
    return { kind: "interval", everyMinutes };
  }
  const time = String(s.time ?? "").slice(0, 5);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error("invalid daily time");
  // strict (create/edit) rejects a bad zone; lenient (loading a stored
  // record on a host whose ICU no longer knows the zone) drops it so the
  // routine survives with process-local wall-clock behavior
  let timeZone: string | undefined;
  if (s.timeZone !== undefined && s.timeZone !== null && s.timeZone !== "") {
    if (isValidTimeZone(s.timeZone)) timeZone = s.timeZone;
    else if (opts.strictTimeZone) throw new Error("invalid time zone");
  }
  return { kind: s.kind === "weekdays" ? "weekdays" : "daily", time, ...(timeZone ? { timeZone } : {}) };
}
const NOTIFY_EVENT_KEYS = new Set(["request.opened", "turn.completed", "stall.nudge", "peer.reply"]);
export function validNotifyEvents(v: unknown): BotRecord["notifyEvents"] | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const out: NonNullable<BotRecord["notifyEvents"]> = {};
  for (const [key, val] of Object.entries(v as Record<string, unknown>)) {
    if (!NOTIFY_EVENT_KEYS.has(key) || typeof val !== "boolean") continue;
    out[key as keyof NonNullable<BotRecord["notifyEvents"]>] = val;
  }
  return Object.keys(out).length ? out : undefined;
}
export function validStringList(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.map((x) => String(x).trim()).filter(Boolean);
  return out;
}

/** Per-bot enabled skill ids. A non-empty `enabledSkills` list wins.
 * Legacy: empty/missing array + `skillId` set → `[skillId]`. */
export function enabledSkillIds(bot: { skillId?: string; enabledSkills?: string[] } | null | undefined): string[] {
  const listed = validStringList(bot?.enabledSkills) ?? [];
  if (listed.length) {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const id of listed) {
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
    return out;
  }
  const legacy = typeof bot?.skillId === "string" ? bot.skillId.trim() : "";
  return legacy ? [legacy] : [];
}

/** Stable unique ids: first-seen order, no silent drop. */
export function uniqueSkillIds(ids: Iterable<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of ids) {
    const id = String(raw).trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}
export function validThenStartTurn(v: unknown): ThenStartTurn | undefined {
  if (!v || typeof v !== "object") return undefined;
  const t = v as Partial<ThenStartTurn>;
  if (typeof t.botId !== "string" || !t.botId.trim()) return undefined;
  if (typeof t.prompt !== "string" || !t.prompt.trim()) return undefined;
  return { botId: t.botId.trim(), prompt: t.prompt.trim() };
}

/** Normalize any historical routine record; null when unrecognizable. */
export function normalizeRoutine(v: unknown): RoutineRecord | null {
  if (!v || typeof v !== "object") return null; const r = v as Partial<RoutineRecord>;
  if (![r.id, r.botId, r.name, r.prompt].every((x) => typeof x === "string") || !r.schedule) return null;
  try {
    const schedule = parseRoutineSchedule(r.schedule);
    const next = Number.isFinite(r.nextRunAt) ? r.nextRunAt! : nextRunAt(schedule);
    const thenStartTurn = validThenStartTurn(r.thenStartTurn);
    const listenerCursor = typeof r.listenerCursor === "string" && r.listenerCursor.trim() ? r.listenerCursor.trim() : undefined;
    return {
      id: r.id!, botId: r.botId!, name: r.name!, prompt: r.prompt!, schedule, enabled: r.enabled !== false,
      running: false, nextRunAt: next, lastRunAt: Number.isFinite(r.lastRunAt) ? r.lastRunAt! : null,
      lastResult: typeof r.lastResult === "string" ? r.lastResult : null,
      createdAt: Number.isFinite(r.createdAt) ? r.createdAt! : Date.now(),
      // run-once is the historical behavior, so legacy records keep it
      missedPolicy: parseMissedPolicy(r.missedPolicy) ?? "run-once",
      ...(thenStartTurn ? { thenStartTurn } : {}),
      ...(typeof r.skillId === "string" && r.skillId.trim() ? { skillId: r.skillId.trim() } : {}),
      ...(listenerCursor ? { listenerCursor } : {}),
    };
  } catch { return null; }
}

export function normalizeMessage(v: unknown): Message | null {
  if (!v || typeof v !== "object") return null;
  const m = v as Partial<Message>;
  if (typeof m.id !== "string") return null;
  return { ...(m as Message), at: Number.isFinite(m.at) ? m.at! : Date.now() };
}

export function normalizeGroup(v: unknown): GroupRecord | null {
  if (!v || typeof v !== "object") return null;
  const g = v as Partial<GroupRecord>;
  if (typeof g.id !== "string" || !g.id || typeof g.threadId !== "string" || !g.threadId) return null;
  if (typeof g.name !== "string") return null;
  const memberIds = validStringList(g.memberIds) ?? [];
  return {
    id: g.id,
    threadId: g.threadId,
    name: g.name,
    memberIds,
    unread: g.unread === true,
    createdAt: Number.isFinite(g.createdAt) ? g.createdAt! : Date.now(),
    ...(g.dm === true ? { dm: true } : {}),
  };
}

export function mentionedBots<T extends { name: string; hidden?: boolean }>(text: string, peers: T[]): T[] {
  const candidates=peers.filter(p=>!p.hidden&&p.name.trim()).sort((a,b)=>b.name.length-a.name.length), lower=text.toLowerCase(), found:T[]=[]; let at=-1;
  while((at=lower.indexOf("@",at+1))!==-1){if(at>0&&!/\s/.test(text[at-1]))continue;const hit=candidates.find(p=>lower.slice(at+1).startsWith(p.name.toLowerCase()));if(hit&&!found.includes(hit))found.push(hit);} return found;
}
export const onboardingCard=():OptionCardData=>({title:"What do you mostly want help with?",subtitle:"Pick whatever's closest; we can always expand from there.",options:["Work & projects","Writing & research","Life admin","A bit of everything"]});
