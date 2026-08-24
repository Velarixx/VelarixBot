/** Client-safe workflow types. Mirrors server/workflow.ts — do not import
 * the server module from the client (it uses `.ts` extensions). */

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
