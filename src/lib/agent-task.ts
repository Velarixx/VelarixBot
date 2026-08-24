/** Client-safe assigned-task types. Mirrors server/agent-tasks.ts — do not
 * import the server module from the client (it uses `.ts` extensions). */

export const AGENT_TASK_STATES = ["pending", "active", "blocked", "completed"] as const;

export type AgentTaskState = (typeof AGENT_TASK_STATES)[number];

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
};

export function isAgentTaskState(value: unknown): value is AgentTaskState {
  return typeof value === "string" && (AGENT_TASK_STATES as readonly string[]).includes(value);
}

export function taskCounts(tasks: readonly Pick<AgentTask, "state">[]): { completed: number; total: number } {
  return { completed: tasks.filter((task) => task.state === "completed").length, total: tasks.length };
}

export function tasksForBot(tasks: readonly AgentTask[], botId: string): AgentTask[] {
  return tasks.filter((task) => task.assigneeBotId === botId).sort((a, b) => a.createdAt - b.createdAt);
}
