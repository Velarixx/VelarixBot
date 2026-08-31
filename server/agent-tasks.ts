// Assigned tasks created when a lead delegates work (#120).
// Queue hygiene (#144 / #148): the active list is pending/active, plus
// blocked only when a structured blocker is present (text + owner + next
// action + updatedAt) and not past BLOCKED_STALE_AFTER_MS. Completed,
// cancelled, superseded, and stale stay in history. SQLite-backed
// (configured at boot); in-memory fallback for unit tests that do not
// wire the repository. Not a second transcript — reports and assignment
// messages still live on the existing messages table.
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

/** Blocked rows whose updatedAt is older than this (ms) leave the active
 * queue as stale. Evaluated at list/read, patch, create, and snapshot —
 * not a timer poller. Pin this export in tests; do not duplicate. */
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
  assignmentMessageId?: string;
  createdAt: number;
  updatedAt: number;
  /** Additive #151 projection: sealed run this row is bound to. */
  runId?: string;
  /** Additive #150 projection: delivery of the sealed run result. */
  deliveryState?: "result_stored" | "delivery_pending" | "delivered" | "delivery_failed";
  runOutcome?: "completed" | "failed" | "interrupted" | "partial";
  failureCode?: string;
}

export type ActiveQueueTask = Pick<
  AgentTask,
  "state" | "blocker" | "blockerOwner" | "nextAction" | "updatedAt"
>;

export function isAgentTaskState(value: unknown): value is AgentTaskState {
  return typeof value === "string" && (AGENT_TASK_STATES as readonly string[]).includes(value);
}

export function normalizeAssignment(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function trimmed(value: string | undefined): string {
  return (value ?? "").trim();
}

/** Blocked stays active only when all four fields are present. */
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

export interface AgentTasksStore {
  insert(task: AgentTask): AgentTask;
  get(id: string): AgentTask | null;
  list(): AgentTask[];
  listByAssignee(botId: string): AgentTask[];
  listBySourceThread(threadId: string): AgentTask[];
  update(id: string, patch: Partial<Omit<AgentTask, "id" | "createdAt">>): AgentTask | null;
  deleteForBot(botId: string): number;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function coerceTaskState(
  state: AgentTaskState,
  blocker?: string,
): { state: AgentTaskState; blocker?: string } {
  // Ledger projection (#151) may write blocked + text without owner/next.
  // Those rows stay blocked in storage; isActiveQueueTask / reconcile treat
  // them as stale for the active queue. Only empty blocker text is coerced
  // here so finalize CAS keeps mapping failed → blocked.
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
    ...(optionalString(row.blockerOwner) ? { blockerOwner: optionalString(row.blockerOwner) } : {}),
    ...(optionalString(row.nextAction) ? { nextAction: optionalString(row.nextAction) } : {}),
    ...(typeof row.assignmentMessageId === "string" && row.assignmentMessageId
      ? { assignmentMessageId: row.assignmentMessageId }
      : {}),
    createdAt: Number.isFinite(row.createdAt) ? Number(row.createdAt) : Date.now(),
    updatedAt: Number.isFinite(row.updatedAt) ? Number(row.updatedAt) : Date.now(),
    ...(optionalString(row.runId) ? { runId: optionalString(row.runId) } : {}),
    ...(row.deliveryState === "result_stored" ||
    row.deliveryState === "delivery_pending" ||
    row.deliveryState === "delivered" ||
    row.deliveryState === "delivery_failed"
      ? { deliveryState: row.deliveryState }
      : {}),
    ...(row.runOutcome === "completed" ||
    row.runOutcome === "failed" ||
    row.runOutcome === "interrupted" ||
    row.runOutcome === "partial"
      ? { runOutcome: row.runOutcome }
      : {}),
    ...(typeof row.failureCode === "string" && row.failureCode ? { failureCode: row.failureCode } : {}),
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

function shouldPersistStale(task: AgentTask, now: number): boolean {
  if (task.state !== "blocked") return false;
  return !hasStructuredBlocker(task) || isBlockedPastStaleness(task, now);
}

/** Persist blocked-without-structure and blocked-past-threshold as stale.
 * Called from list/read wrappers, patch, create, and snapshot. No poller. */
export function reconcileStaleBlocked(now = Date.now()): AgentTask[] {
  const changed: AgentTask[] = [];
  for (const task of store.list()) {
    if (!shouldPersistStale(task, now)) continue;
    const next = store.update(task.id, { state: "stale" });
    if (next) changed.push(next);
  }
  return changed;
}

export function getAgentTask(id: string, now = Date.now()): AgentTask | null {
  const task = store.get(id);
  if (!task) return null;
  if (!shouldPersistStale(task, now)) return task;
  return store.update(task.id, { state: "stale" }) ?? task;
}

export function listAgentTasks(now = Date.now()): AgentTask[] {
  reconcileStaleBlocked(now);
  return store.list();
}

function openFromSameSource(
  input: {
    assigneeBotId: string;
    fromBotId: string;
    sourceThreadId: string;
  },
  now: number,
): AgentTask[] {
  return store.listByAssignee(input.assigneeBotId).filter(
    (task) =>
      task.fromBotId === input.fromBotId &&
      task.sourceThreadId === input.sourceThreadId &&
      isActiveQueueTask(task, now),
  );
}

function openWithRunId(runId: string, now: number): AgentTask[] {
  const id = runId.trim();
  if (!id) return [];
  return store.list().filter((task) => task.runId === id && isActiveQueueTask(task, now));
}

export function createAgentTask(input: {
  assigneeBotId: string;
  fromBotId: string;
  fromName: string;
  sourceThreadId: string;
  assignment: string;
  reason?: string;
  assignmentMessageId?: string;
  runId?: string;
  now?: number;
}): AgentTask {
  const now = input.now ?? Date.now();
  reconcileStaleBlocked(now);
  const normalized = normalizeAssignment(input.assignment);
  const runId = optionalString(input.runId);
  const open = openFromSameSource(input, now);
  const duplicate = open.find((task) => normalizeAssignment(task.assignment) === normalized);
  if (duplicate) {
    return (
      store.update(duplicate.id, {
        updatedAt: now,
        ...(input.assignmentMessageId ? { assignmentMessageId: input.assignmentMessageId } : {}),
        ...(runId ? { runId } : {}),
      }) ?? duplicate
    );
  }
  const superseded = new Set<string>();
  for (const previous of open) {
    store.update(previous.id, { state: "superseded", updatedAt: now });
    superseded.add(previous.id);
  }
  if (runId) {
    for (const previous of openWithRunId(runId, now)) {
      if (superseded.has(previous.id)) continue;
      store.update(previous.id, { state: "superseded", updatedAt: now });
    }
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
    ...(runId ? { runId } : {}),
    createdAt: now,
    updatedAt: now,
  };
  return store.insert(task);
}

export type AgentTaskPatch = Partial<
  Pick<
    AgentTask,
    | "state"
    | "result"
    | "blocker"
    | "blockerOwner"
    | "nextAction"
    | "reason"
    | "assignmentMessageId"
    | "runId"
  >
>;

export function patchAgentTask(id: string, patch: AgentTaskPatch, now = Date.now()): AgentTask | null {
  reconcileStaleBlocked(now);
  const existing = store.get(id);
  if (!existing) return null;
  const merged = { ...existing, ...patch, updatedAt: now };
  if (merged.state === "blocked" && !hasStructuredBlocker(merged)) {
    return store.update(id, { ...patch, state: "stale", updatedAt: now });
  }
  return store.update(id, { ...patch, updatedAt: now });
}

/** Mark an assignee turn that finished: ok+result → completed, cancel →
 * cancelled, else with detail → blocked only when owner + next action can
 * be filled, otherwise stale. Applied at that transition — not a
 * wall-clock poller. */
export function assigneeTurnTaskPatch(outcome: {
  ok: boolean;
  text?: string;
  detail?: string;
  blockerOwner?: string;
  nextAction?: string;
}): AgentTaskPatch {
  const result = (outcome.text ?? "").trim();
  const detail = (outcome.detail ?? "").trim();
  if (isCancelledAssigneeOutcome(detail) || isCancelledAssigneeOutcome(result)) {
    return { state: "cancelled" };
  }
  if (outcome.ok) {
    return result ? { state: "completed", result } : { state: "stale" };
  }
  const blocker = detail || result;
  const blockerOwner = trimmed(outcome.blockerOwner);
  const nextAction = trimmed(outcome.nextAction);
  if (blocker && blockerOwner && nextAction) {
    return { state: "blocked", blocker, blockerOwner, nextAction };
  }
  return { state: "stale" };
}

function isCancelledAssigneeOutcome(value: string): boolean {
  return /^(interrupted|cancelled|canceled)$/i.test(value);
}

export function openTasksForSource(sourceThreadId: string, now = Date.now()): AgentTask[] {
  return store
    .listBySourceThread(sourceThreadId)
    .filter((task) => task.state === "pending" || task.state === "active")
    .filter((task) => isActiveQueueTask(task, now));
}

export function taskCounts(tasks: readonly ActiveQueueTask[], now = Date.now()): {
  assigned: number;
  active: number;
} {
  const active = tasks.filter((task) => isActiveQueueTask(task, now)).length;
  return { assigned: active, active };
}

export function activeQueueTasks<T extends ActiveQueueTask>(tasks: readonly T[], now = Date.now()): T[] {
  return tasks.filter((task) => isActiveQueueTask(task, now));
}

export function archivedTasks<T extends ActiveQueueTask>(tasks: readonly T[], now = Date.now()): T[] {
  return tasks.filter((task) => isArchivedTask(task, now));
}
