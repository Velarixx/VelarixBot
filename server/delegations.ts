// Async peer handoff (delegate_bot).
//
// A coordinator queues work for a teammate and does not wait. The source
// turn returns "Delegation queued." immediately; drain runs on
// turn.completed and starts the peer at depth+1. Fail/interrupt discards
// the queue and drops the source chip. In-memory only — a restart drops
// the queue (do not persist).
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
}

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
  const chip = bus.store.appendMessage(sourceThreadId, {
    role: "bot",
    kind: "activity",
    tool: { name: label },
  });
  bus.broadcast({ kind: "message", threadId: sourceThreadId, message: chip });
  list.push({ ...item, id: newId(), chipMessageId: chip.id });
  pendingDelegations.set(sourceThreadId, list);
  return "ok";
}

/** Drain queued delegations for a source thread (called on turn.completed).
 * Synchronous until runTarget is invoked — no approval gate, no persist. */
export function drainDelegations(
  bus: CommsBus,
  threadId: string,
  runTarget: (
    toBotId: string,
    message: string,
    commsDepth: number,
    sourceThreadId: string,
    channel?: GroupRecord,
  ) => void,
): void {
  const list = pendingDelegations.get(threadId);
  if (!list?.length) return;
  const from = bus.store.botByThread(threadId);
  pendingDelegations.delete(threadId);
  if (!from) return;
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
    if (!item.chipMessageId) continue;
    const existing = bus.store.messagesFor(threadId).find((m) => m.id === item.chipMessageId);
    const name = existing?.tool?.name ?? "Delegated to @";
    const patched = bus.store.patchMessage(threadId, item.chipMessageId, {
      tool: { name, ok: false },
    });
    if (patched) bus.broadcast({ kind: "message.patch", threadId, message: patched });
  }
  const note = bus.store.appendMessage(threadId, {
    role: "bot",
    kind: "activity",
    tool: {
      name: `${list.length} queued delegation${list.length > 1 ? "s" : ""} dropped — the turn did not finish`,
      ok: false,
    },
  });
  bus.broadcast({ kind: "message", threadId, message: note });
}

function processOne(
  bus: CommsBus,
  from: BotRecord,
  sourceThreadId: string,
  item: PendingDelegationItem,
  runTarget: (
    toBotId: string,
    message: string,
    commsDepth: number,
    sourceThreadId: string,
    channel?: GroupRecord,
  ) => void,
): void {
  const target = bus.store.bot(item.toBotId);
  if (!target) {
    const note = bus.store.appendMessage(sourceThreadId, {
      role: "bot",
      kind: "activity",
      tool: { name: `error: delegation to ${item.toBotId} failed — no such bot`, ok: false },
    });
    bus.broadcast({ kind: "message", threadId: sourceThreadId, message: note });
    return;
  }
  if (target.busy) {
    const note = bus.store.appendMessage(sourceThreadId, {
      role: "bot",
      kind: "activity",
      tool: { name: `Delegation to @${target.name} canceled — @${target.name} is busy`, ok: false },
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
        comm: { groupId: channel.id, withBotId: target.id, withName: target.name, withColor: target.color },
      });
      if (patched) bus.broadcast({ kind: "message.patch", threadId: sourceThreadId, message: patched });
    }
  }
  mirrorExchange(bus, from, target, item.message, channel, sourceThreadId);
  const reasonLine = item.reason ? `\n\n[Reason: ${item.reason}]` : "";
  const prefixed = `[Delegated by @${from.name}, another bot in this VelarixBot workspace. Do the work and reply directly.]\n\n${item.message}${reasonLine}`;
  runTarget(item.toBotId, prefixed, item.depth + 1, sourceThreadId, channel);
}

/** Test helper: how many items remain queued for a thread. */
export function _pendingCount(threadId: string): number {
  return pendingDelegations.get(threadId)?.length ?? 0;
}

/** Test helper: forget the in-memory queue (a simulated restart). */
export function _resetPending(): void {
  pendingDelegations.clear();
}
