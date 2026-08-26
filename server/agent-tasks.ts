// Assigned tasks created when a lead delegates work (#120).
// Queue hygiene (#144): the active list is pending/active/blocked; completed,
// cancelled, superseded, and stale stay in history. SQLite-backed (configured
// at boot); in-memory fallback for unit tests that do not wire the repository.
// Not a second transcript — reports and assignment messages still live on the
// existing messages table.
import { newId } from "./contracts.ts";

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
  assignmentMessageId?: string;
  createdAt: number;
  updatedAt: number;
}

export function isAgentTaskState(value: unknown): value is AgentTaskState {
  return typeof value === "string" && (AGENT_TASK_STATES as readonly string[]).includes(value);
}

export function normalizeAssignment(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

export function isActiveQueueTask(task: Pick<AgentTask, "state" | "blocker">): boolean {
  if (task.state === "pending" || task.state === "active") return true;
  return task.state === "blocked" && Boolean(task.blocker?.trim());
}

export function isArchivedTask(task: Pick<AgentTask, "state" | "blocker">): boolean {
  return !isActiveQueueTask(task);
}

export interface AgentTasksStore {
  insert(task: AgentTask): AgentTask;
  get(id: string): AgentTask | null;
  list(): AgentTask[];
  listByAssignee(botId: string): AgentTask[];
  listBySourceThread(threadId: string): AgentTask[];
  update(id: string, patch: Partial<Omit<AgentTask, "id" | "createdAt">>): AgentTask | null;
  deleteForBot(botId: string): number;
}

function coerceTaskState(state: AgentTaskState, blocker?: string): { state: AgentTaskState; blocker?: string } {
  if (state === "blocked" && !blocker?.trim()) return { state: "stale" };
  return blocker?.trim() ? { state, blocker } : { state };
}

export function normalizeAgentTask(value: unknown): AgentTask | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Partial<AgentTask>;
  if (typeof row.id !== "string" || !row.id) return null;
  if (typeof row.assigneeBotId !== "string" || !row.assigneeBotId) return null;
  if (typeof row.fromBotId !== "string" || !row.fromBotId) return null;
  if (typeof row.sourceThreadId !== "string" || !row.sourceThreadId) return null;
  if (typeof row.assignment !== "string") return null;
  if (!isAgentTaskState(row.state)) return null;
  const blocker = typeof row.blocker === "string" && row.blocker ? row.blocker : undefined;
  const coerced = coerceTaskState(row.state, blocker);
  return {
    id: row.id,
    assigneeBotId: row.assigneeBotId,
    fromBotId: row.fromBotId,
    fromName: typeof row.fromName === "string" && row.fromName.trim() ? row.fromName.trim() : "Lead",
    sourceThreadId: row.sourceThreadId,
    assignment: row.assignment,
    ...(typeof row.reason === "string" && row.reason.trim() ? { reason: row.reason.trim() } : {}),
    state: coerced.state,
    ...(typeof row.result === "string" && row.result ? { result: row.result } : {}),
    ...(coerced.blocker ? { blocker: coerced.blocker } : {}),
    ...(typeof row.assignmentMessageId === "string" && row.assignmentMessageId
      ? { assignmentMessageId: row.assignmentMessageId }
      : {}),
    createdAt: Number.isFinite(row.createdAt) ? Number(row.createdAt) : Date.now(),
    updatedAt: Number.isFinite(row.updatedAt) ? Number(row.updatedAt) : Date.now(),
  };
}

export function createMemoryAgentTasksStore(): AgentTasksStore {
  const rows = new Map<string, AgentTask>();
  return {
    insert(task) {
      rows.set(task.id, task);
      return task;
    },
    get(id) {
      return rows.get(id) ?? null;
    },
    list() {
      return [...rows.values()].sort((a, b) => a.createdAt - b.createdAt);
    },
    listByAssignee(botId) {
      return this.list().filter((task) => task.assigneeBotId === botId);
    },
    listBySourceThread(threadId) {
      return this.list().filter((task) => task.sourceThreadId === threadId);
    },
    update(id, patch) {
      const existing = rows.get(id);
      if (!existing) return null;
      const next = normalizeAgentTask({ ...existing, ...patch, id, createdAt: existing.createdAt });
      if (!next) return null;
      rows.set(id, next);
      return next;
    },
    deleteForBot(botId) {
      let n = 0;
      for (const [id, task] of rows) {
        if (task.assigneeBotId === botId || task.fromBotId === botId) {
          rows.delete(id);
          n += 1;
        }
      }
      return n;
    },
  };
}

let store: AgentTasksStore = createMemoryAgentTasksStore();

/** Composition root wires the SQLite store. Tests inject a fake or reset. */
export function configureAgentTasks(next: AgentTasksStore | null): void {
  store = next ?? createMemoryAgentTasksStore();
}

export function agentTasks(): AgentTasksStore {
  return store;
}

function openFromSameSource(input: {
  assigneeBotId: string;
  fromBotId: string;
  sourceThreadId: string;
}): AgentTask[] {
  return store.listByAssignee(input.assigneeBotId).filter(
    (task) =>
      task.fromBotId === input.fromBotId &&
      task.sourceThreadId === input.sourceThreadId &&
      isActiveQueueTask(task),
  );
}

export function createAgentTask(input: {
  assigneeBotId: string;
  fromBotId: string;
  fromName: string;
  sourceThreadId: string;
  assignment: string;
  reason?: string;
  assignmentMessageId?: string;
  now?: number;
}): AgentTask {
  const now = input.now ?? Date.now();
  const normalized = normalizeAssignment(input.assignment);
  const open = openFromSameSource(input);
  const duplicate = open.find((task) => normalizeAssignment(task.assignment) === normalized);
  if (duplicate) {
    return (
      store.update(duplicate.id, {
        updatedAt: now,
        ...(input.assignmentMessageId ? { assignmentMessageId: input.assignmentMessageId } : {}),
      }) ?? duplicate
    );
  }
  for (const previous of open) {
    store.update(previous.id, { state: "superseded", updatedAt: now });
  }
  const task: AgentTask = {
    id: newId(),
    assigneeBotId: input.assigneeBotId,
    fromBotId: input.fromBotId,
    fromName: input.fromName,
    sourceThreadId: input.sourceThreadId,
    assignment: input.assignment,
    ...(input.reason ? { reason: input.reason } : {}),
    state: "pending",
    ...(input.assignmentMessageId ? { assignmentMessageId: input.assignmentMessageId } : {}),
    createdAt: now,
    updatedAt: now,
  };
  return store.insert(task);
}

export function patchAgentTask(
  id: string,
  patch: Partial<Pick<AgentTask, "state" | "result" | "blocker" | "reason" | "assignmentMessageId">>,
  now = Date.now(),
): AgentTask | null {
  return store.update(id, { ...patch, updatedAt: now });
}

/** Mark an assignee turn that finished: result → completed, cancel → cancelled,
 * blocker text → blocked, otherwise stale. Applied at that transition — not a
 * wall-clock poller. */
export function assigneeTurnTaskPatch(outcome: {
  ok: boolean;
  text?: string;
  detail?: string;
}): Partial<Pick<AgentTask, "state" | "result" | "blocker">> {
  const result = (outcome.text ?? "").trim();
  const detail = (outcome.detail ?? "").trim();
  if (isCancelledAssigneeOutcome(detail) || isCancelledAssigneeOutcome(result)) {
    return { state: "cancelled" };
  }
  if (outcome.ok) {
    return result ? { state: "completed", result } : { state: "stale" };
  }
  if (detail || result) return { state: "blocked", blocker: detail || result };
  return { state: "stale" };
}

function isCancelledAssigneeOutcome(value: string): boolean {
  return /^(interrupted|cancelled|canceled)$/i.test(value);
}

export function openTasksForSource(sourceThreadId: string): AgentTask[] {
  return store.listBySourceThread(sourceThreadId).filter((task) => task.state === "pending" || task.state === "active");
}

export function taskCounts(tasks: readonly Pick<AgentTask, "state" | "blocker">[]): {
  assigned: number;
  active: number;
} {
  const active = tasks.filter(isActiveQueueTask).length;
  return { assigned: active, active };
}

export function activeQueueTasks<T extends Pick<AgentTask, "state" | "blocker">>(tasks: readonly T[]): T[] {
  return tasks.filter(isActiveQueueTask);
}

export function archivedTasks<T extends Pick<AgentTask, "state" | "blocker">>(tasks: readonly T[]): T[] {
  return tasks.filter(isArchivedTask);
}
