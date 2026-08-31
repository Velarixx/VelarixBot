/** Client-safe assigned-task types. Mirrors server/agent-tasks.ts — do not
 * import the server module from the client (it uses `.ts` extensions). */

export const AGENT_TASK_STATES = [
  "pending",
  "active",
  "blocked",
  "completed",
  "cancelled",
  "superseded",
  "stale",
] as const;

export type AgentTaskState = (typeof AGENT_TASK_STATES)[number];

export const ACTIVE_QUEUE_STATES = ["pending", "active", "blocked"] as const;
export const ARCHIVED_TASK_STATES = ["completed", "cancelled", "superseded", "stale"] as const;

/** Must match server/agent-tasks.ts BLOCKED_STALE_AFTER_MS. Pin in tests. */
export const BLOCKED_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

export interface AgentTask {
  id: string;
  assigneeBotId: string;
  fromBotId: string;
  fromName: string;
  sourceThreadId: string;
  assignment: string;
  reason?: string;
  state: AgentTaskState;
  result?: string;
  blocker?: string;
  blockerOwner?: string;
  nextAction?: string;
  createdAt: number;
  updatedAt: number;
  runId?: string;
  deliveryState?: "result_stored" | "delivery_pending" | "delivered" | "delivery_failed";
  runOutcome?: "completed" | "failed" | "interrupted" | "partial";
  failureCode?: string;
}

export type ActiveQueueTask = Pick<
  AgentTask,
  "state" | "blocker" | "blockerOwner" | "nextAction" | "updatedAt"
>;

export const AGENT_TASK_STATE_LABEL: Record<AgentTaskState, string> = {
  pending: "Pending",
  active: "Active",
  blocked: "Blocked",
  completed: "Completed",
  cancelled: "Cancelled",
  superseded: "Superseded",
  stale: "Stale",
};

export function isAgentTaskState(value: unknown): value is AgentTaskState {
  return typeof value === "string" && (AGENT_TASK_STATES as readonly string[]).includes(value);
}

function trimmed(value: string | undefined): string {
  return (value ?? "").trim();
}

export function hasStructuredBlocker(task: ActiveQueueTask): boolean {
  return Boolean(
    trimmed(task.blocker) &&
      trimmed(task.blockerOwner) &&
      trimmed(task.nextAction) &&
      Number.isFinite(task.updatedAt),
  );
}

export function isBlockedPastStaleness(task: Pick<AgentTask, "state" | "updatedAt">, now: number): boolean {
  return task.state === "blocked" && Number.isFinite(task.updatedAt) && now - task.updatedAt > BLOCKED_STALE_AFTER_MS;
}

export function isActiveQueueTask(task: ActiveQueueTask, now = Date.now()): boolean {
  if (task.state === "pending" || task.state === "active") return true;
  if (task.state !== "blocked") return false;
  return hasStructuredBlocker(task) && !isBlockedPastStaleness(task, now);
}

export function isArchivedTask(task: ActiveQueueTask, now = Date.now()): boolean {
  return !isActiveQueueTask(task, now);
}

export function taskCounts(tasks: readonly ActiveQueueTask[], now = Date.now()): {
  assigned: number;
  active: number;
} {
  const active = tasks.filter((task) => isActiveQueueTask(task, now)).length;
  return { assigned: active, active };
}

export function tasksForBot(tasks: readonly AgentTask[], botId: string): AgentTask[] {
  return tasks.filter((task) => task.assigneeBotId === botId).sort((a, b) => a.createdAt - b.createdAt);
}

export function activeTasksForBot(tasks: readonly AgentTask[], botId: string, now = Date.now()): AgentTask[] {
  return tasksForBot(tasks, botId).filter((task) => isActiveQueueTask(task, now));
}

export function archivedTasksForBot(tasks: readonly AgentTask[], botId: string, now = Date.now()): AgentTask[] {
  return tasksForBot(tasks, botId).filter((task) => isArchivedTask(task, now));
}

export type AgentTaskUserAction = "cancel" | "dismiss" | "obsolete";

export function userActionTaskPatch(action: AgentTaskUserAction): {
  state: "cancelled" | "stale";
  reason: string;
} {
  if (action === "cancel") return { state: "cancelled", reason: "Cancelled" };
  if (action === "dismiss") return { state: "stale", reason: "Dismissed" };
  return { state: "stale", reason: "Obsolete" };
}
