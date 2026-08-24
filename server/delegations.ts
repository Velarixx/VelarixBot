// Async peer handoff (delegate_bot).
//
// A coordinator queues work for a teammate and does not wait. The source
// turn returns "Delegation queued." immediately; drain runs on
// turn.completed and starts the peer at depth+1. Fail/interrupt discards
// the queue and drops the source chip. In-memory only — a restart drops
// the queue (do not persist).
import { completedNote, failedNote } from "./activity-status.ts";
import { createAgentTask, patchAgentTask } from "./agent-tasks.ts";
import { newId } from "./contracts.ts";
import { getOrCreateChannel, mirrorExchange, type CommsBus } from "./comms-visibility.ts";
import type { BotRecord, GroupRecord } from "./store.ts";

export interface DelegationItem {
  toBotId: string;
  message: string;
  reason?: string;
  /** The source bot's comms depth (0 for a user-initiated turn). The
   * delegated-to bot runs at `depth + 1`. Queue rejects depth >= cap so
   * A→B→C via delegate_bot is impossible. */
  depth: number;
}

interface PendingDelegationItem extends DelegationItem {
  id: string;
  chipMessageId?: string;
  taskId?: string;
}

export type DrainRunTarget = (
  toBotId: string,
  message: string,
  commsDepth: number,
  sourceThreadId: string,
  channel?: GroupRecord,
  taskId?: string,
) => void;

export type QueueResult = "ok" | "no_target" | "self" | "too_deep" | "too_many";

const pendingDelegations = new Map<string, PendingDelegationItem[]>();

/** How many handoffs one source thread may queue. */
export const MAX_QUEUED_PER_THREAD = 4;

/** Only a user-initiated (depth 0) turn may delegate — target runs at 1. */
export const MAX_DELEGATION_DEPTH = 1;

export function queueDelegation(
  bus: CommsBus,
  from: BotRecord,
  item: DelegationItem,
  maxDepth: number = MAX_DELEGATION_DEPTH,
  sourceThreadId = from.threadId,
): QueueResult {
  if (item.toBotId === from.id) return "self";
  if (item.depth >= maxDepth) return "too_deep";
  const target = bus.store.bot(item.toBotId);
  if (!target) return "no_target";
  const list = pendingDelegations.get(sourceThreadId) ?? [];
  if (list.length >= MAX_QUEUED_PER_THREAD) return "too_many";
  const label = `Delegated to @${target.name}${item.reason ? `: ${item.reason}` : ""}`;
  const assignment = bus.store.appendMessage(target.threadId, {
    role: "bot",
    kind: "text",
    text: item.message,
    from: { botId: from.id, name: from.name, color: from.color },
  });
  const task = createAgentTask({
    assigneeBotId: target.id,
    fromBotId: from.id,
    fromName: from.name,
    sourceThreadId,
    assignment: item.message,
    reason: item.reason,
    assignmentMessageId: assignment.id,
  });
  const assigned = bus.store.patchMessage(target.threadId, assignment.id, {
    task: { id: task.id },
    report: { kind: "handoff", fromBotId: from.id, taskId: task.id },
  });
  bus.broadcast({ kind: "message", threadId: target.threadId, message: assigned ?? assignment });
  bus.broadcast({ kind: "task", task });
  const chip = bus.store.appendMessage(sourceThreadId, {
    role: "bot",
    kind: "activity",
    tool: { name: label }, // running until drain or discard
    report: { kind: "handoff", fromBotId: from.id, taskId: task.id },
    task: { id: task.id },
  });
  bus.broadcast({ kind: "message", threadId: sourceThreadId, message: chip });
  list.push({ ...item, id: newId(), chipMessageId: chip.id, taskId: task.id });
  pendingDelegations.set(sourceThreadId, list);
  return "ok";
}

/** Drain queued delegations for a source thread (called on turn.completed).
 * Synchronous until runTarget is invoked — no approval gate, no persist. */
export function drainDelegations(
  bus: CommsBus,
  threadId: string,
  runTarget: DrainRunTarget,
): void {
  const list = pendingDelegations.get(threadId);
  if (!list?.length) return;
  const from = bus.store.botByThread(threadId);
  pendingDelegations.delete(threadId);
  if (!from) {
    for (const item of list) {
      if (item.taskId) {
        const task = patchAgentTask(item.taskId, {
          state: "blocked",
          blocker: "The source turn finished without a lead bot",
        });
        if (task) bus.broadcast({ kind: "task", task });
      }
    }
    return;
  }
  for (const item of list) {
    processOne(bus, from, threadId, item, runTarget);
  }
}

/** Drop a thread's queued handoffs without running them, and drop the
 * source "Delegated to @Name" chips (failed/interrupted source turn). */
export function discardDelegations(bus: CommsBus, threadId: string): void {
  const list = pendingDelegations.get(threadId);
  if (!list?.length) return;
  pendingDelegations.delete(threadId);
  for (const item of list) {
    if (item.taskId) {
      const task = patchAgentTask(item.taskId, {
        state: "blocked",
        blocker: "The source turn did not finish",
      });
      if (task) bus.broadcast({ kind: "task", task });
    }
    if (!item.chipMessageId) continue;
    const existing = bus.store.messagesFor(threadId).find((m) => m.id === item.chipMessageId);
    const name = existing?.tool?.name ?? "Delegated to @";
    const patched = bus.store.patchMessage(threadId, item.chipMessageId, {
      tool: failedNote(name, "cancelled"),
    });
    if (patched) bus.broadcast({ kind: "message.patch", threadId, message: patched });
  }
  const note = bus.store.appendMessage(threadId, {
    role: "bot",
    kind: "activity",
    tool: failedNote(
      `${list.length} queued delegation${list.length > 1 ? "s" : ""} dropped — the turn did not finish`,
      "cancelled",
    ),
  });
  bus.broadcast({ kind: "message", threadId, message: note });
}

function processOne(
  bus: CommsBus,
  from: BotRecord,
  sourceThreadId: string,
  item: PendingDelegationItem,
  runTarget: DrainRunTarget,
): void {
  const target = bus.store.bot(item.toBotId);
  if (!target) {
    if (item.taskId) {
      const task = patchAgentTask(item.taskId, {
        state: "blocked",
        blocker: `error: delegation to ${item.toBotId} failed — no such bot`,
      });
      if (task) bus.broadcast({ kind: "task", task });
    }
    if (item.chipMessageId) {
      const existing = bus.store.messagesFor(sourceThreadId).find((m) => m.id === item.chipMessageId);
      const patched = bus.store.patchMessage(sourceThreadId, item.chipMessageId, {
        tool: failedNote(existing?.tool?.name ?? `Delegated to ${item.toBotId}`),
      });
      if (patched) bus.broadcast({ kind: "message.patch", threadId: sourceThreadId, message: patched });
    }
    const note = bus.store.appendMessage(sourceThreadId, {
      role: "bot",
      kind: "activity",
      tool: failedNote(`error: delegation to ${item.toBotId} failed — no such bot`),
    });
    bus.broadcast({ kind: "message", threadId: sourceThreadId, message: note });
    return;
  }
  if (target.busy) {
    if (item.taskId) {
      const task = patchAgentTask(item.taskId, {
        state: "blocked",
        blocker: `@${target.name} is busy`,
      });
      if (task) bus.broadcast({ kind: "task", task });
    }
    if (item.chipMessageId) {
      const existing = bus.store.messagesFor(sourceThreadId).find((m) => m.id === item.chipMessageId);
      const patched = bus.store.patchMessage(sourceThreadId, item.chipMessageId, {
        tool: failedNote(existing?.tool?.name ?? `Delegated to @${target.name}`, "cancelled"),
      });
      if (patched) bus.broadcast({ kind: "message.patch", threadId: sourceThreadId, message: patched });
    }
    const note = bus.store.appendMessage(sourceThreadId, {
      role: "bot",
      kind: "activity",
      tool: failedNote(`Delegation to @${target.name} canceled — @${target.name} is busy`, "cancelled"),
    });
    bus.broadcast({ kind: "message", threadId: sourceThreadId, message: note });
    return;
  }
  const channel = getOrCreateChannel(bus.store, from, target);
  bus.broadcast({ kind: "group", group: channel });
  if (item.chipMessageId) {
    const existing = bus.store.messagesFor(sourceThreadId).find((m) => m.id === item.chipMessageId);
    if (existing) {
      const patched = bus.store.patchMessage(sourceThreadId, item.chipMessageId, {
        tool: completedNote(existing.tool?.name ?? `Delegated to @${target.name}`),
        comm: { groupId: channel.id, withBotId: target.id, withName: target.name, withColor: target.color },
        report: { kind: "handoff", fromBotId: from.id, taskId: item.taskId },
        task: item.taskId ? { id: item.taskId } : existing.task,
      });
      if (patched) bus.broadcast({ kind: "message.patch", threadId: sourceThreadId, message: patched });
    }
  }
  if (item.taskId) {
    const task = patchAgentTask(item.taskId, { state: "active" });
    if (task) bus.broadcast({ kind: "task", task });
  }
  mirrorExchange(bus, from, target, item.message, channel, sourceThreadId);
  const reasonLine = item.reason ? `\n\n[Reason: ${item.reason}]` : "";
  const prefixed = `[Delegated by @${from.name}, another bot in this VelarixBot workspace. Do the work and reply directly.]\n\n${item.message}${reasonLine}`;
  runTarget(item.toBotId, prefixed, item.depth + 1, sourceThreadId, channel, item.taskId);
}

/** Test helper: how many items remain queued for a thread. */
export function _pendingCount(threadId: string): number {
  return pendingDelegations.get(threadId)?.length ?? 0;
}

/** Test helper: forget the in-memory queue (a simulated restart). */
export function _resetPending(): void {
  pendingDelegations.clear();
}
