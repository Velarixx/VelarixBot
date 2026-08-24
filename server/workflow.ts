// Lead-agent workflow status + full-autonomy stop reasons.
// Persist on the bot record (SQLite JSON). Not a second state machine for
// BotState — that stays IDLE/RUNNING/DONE/BLOCKED/NEEDS_INPUT for mascot
// and existing cards. This is the explicit lead-chat chip (#116).

export const WORKFLOW_STATUSES = [
  "working",
  "waiting",
  "blocked",
  "needs_input",
  "paused",
  "completed",
] as const;

export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];

export interface WorkflowWaitingFor {
  botId: string;
  name: string;
}

export const MAX_AUTONOMY_HOPS = 8;

export function isWorkflowStatus(value: unknown): value is WorkflowStatus {
  return typeof value === "string" && (WORKFLOW_STATUSES as readonly string[]).includes(value);
}

export function waitingLabel(waitingFor?: WorkflowWaitingFor[] | null): string {
  const names = (waitingFor ?? []).map((item) => item.name.trim()).filter(Boolean);
  if (names.length === 0) return "Waiting for agent";
  if (names.length === 1) return `Waiting for @${names[0]}`;
  if (names.length === 2) return `Waiting for @${names[0]} and @${names[1]}`;
  return `Waiting for @${names[0]} and ${names.length - 1} others`;
}

export function workflowLabel(status: WorkflowStatus, waitingFor?: WorkflowWaitingFor[] | null): string {
  if (status === "waiting") return waitingLabel(waitingFor);
  if (status === "needs_input") return "Needs input";
  return status[0].toUpperCase() + status.slice(1).replaceAll("_", " ");
}

export const AUTONOMY_STOP = {
  completed: "Workflow completed.",
  off: "Full-autonomy is off — send a message to continue.",
  paused: "You paused this turn.",
  approval: "Autonomous execution stopped — a safety-sensitive action needs approval.",
  input: "Autonomous execution stopped — the lead needs your input.",
  boundary: `Stopped at the configured safety boundary (${MAX_AUTONOMY_HOPS} autonomous continues).`,
  blocked(detail: string): string {
    return `Autonomous execution stopped — ${detail}`;
  },
  peerBlocked(name: string, detail?: string): string {
    return `Autonomous execution stopped — @${name} is blocked${detail ? `: ${detail}` : "."}`;
  },
};

export const AUTONOMY_CONTINUE_PROMPT =
  "[Full-autonomy continue] Review the delegated-agent reports in this transcript. Continue planning, delegating, reviewing results, and advancing the workflow until completion, a real blocker, or a configured safety boundary. Do not ask the user for a routine progress prompt. Safety-sensitive actions still require configured approval.";

export function isAutonomyContinueText(text: string): boolean {
  return text.startsWith("[Full-autonomy continue]");
}

export function validWaitingFor(value: unknown): WorkflowWaitingFor[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: WorkflowWaitingFor[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const row = item as { botId?: unknown; name?: unknown };
    if (typeof row.botId !== "string" || !row.botId.trim()) continue;
    if (typeof row.name !== "string" || !row.name.trim()) continue;
    out.push({ botId: row.botId.trim(), name: row.name.trim() });
  }
  return out;
}

export function upsertWaitingFor(
  current: WorkflowWaitingFor[] | undefined,
  add: WorkflowWaitingFor,
): WorkflowWaitingFor[] {
  const rest = (current ?? []).filter((item) => item.botId !== add.botId);
  return [...rest, add];
}

export function removeWaitingFor(
  current: WorkflowWaitingFor[] | undefined,
  botId: string,
): WorkflowWaitingFor[] {
  return (current ?? []).filter((item) => item.botId !== botId);
}
