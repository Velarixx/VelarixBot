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
  createdAt: number;
  updatedAt: number;
}

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

export function isActiveQueueTask(task: Pick<AgentTask, "state" | "blocker">): boolean {
  if (task.state === "pending" || task.state === "active") return true;
  return task.state === "blocked" && Boolean(task.blocker?.trim());
}

export function isArchivedTask(task: Pick<AgentTask, "state" | "blocker">): boolean {
  return !isActiveQueueTask(task);
}

export function taskCounts(tasks: readonly Pick<AgentTask, "state" | "blocker">[]): {
  assigned: number;
  active: number;
} {
  const active = tasks.filter(isActiveQueueTask).length;
  return { assigned: active, active };
}

export function tasksForBot(tasks: readonly AgentTask[], botId: string): AgentTask[] {
  return tasks.filter((task) => task.assigneeBotId === botId).sort((a, b) => a.createdAt - b.createdAt);
}

export function activeTasksForBot(tasks: readonly AgentTask[], botId: string): AgentTask[] {
  return tasksForBot(tasks, botId).filter(isActiveQueueTask);
}

export function archivedTasksForBot(tasks: readonly AgentTask[], botId: string): AgentTask[] {
  return tasksForBot(tasks, botId).filter(isArchivedTask);
}
