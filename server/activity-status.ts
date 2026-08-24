// Activity chips in chat: running until a terminal outcome lands.
// Later workflow steps and reconnect/reload must not leave an earlier
// command, communication, or tool spinning.

import { redactSecrets } from "./redact-text.ts";

export type ActivityStatus = "completed" | "failed" | "cancelled" | "timed_out";

export interface ActivityTool {
  name: string;
  ok?: boolean;
  status?: ActivityStatus;
  command?: string;
}

export interface ActivityOutcome {
  ok: boolean;
  status: ActivityStatus;
}

export function redactCommand(text: string): string {
  return redactSecrets(text);
}

export function firstCommandLine(text: string): string {
  return text.split(/\r?\n/, 1)[0] ?? text;
}

export function activityStatusFromOutcome(ok: boolean, reason?: string | null): ActivityStatus {
  const r = (reason ?? "").toLowerCase().replace(/[\s-]+/g, "_");
  if (r.includes("timed_out") || r.includes("timeout") || r.includes("computer_busy")) return "timed_out";
  if (r.includes("cancel") || r.includes("interrupt")) return "cancelled";
  return ok ? "completed" : "failed";
}

export function activityOutcome(ok: boolean, reason?: string | null): ActivityOutcome {
  const status = activityStatusFromOutcome(ok, reason);
  return { ok: status === "completed", status };
}

/** Map a provider tool-call status string to a terminal outcome, or null if still running. */
export function terminalToolStatus(status: string): { ok: boolean; reason?: string } | null {
  const s = status.toLowerCase().replace(/[\s-]+/g, "_");
  if (s === "completed" || s === "success" || s === "succeeded" || s === "done") return { ok: true };
  if (s === "failed" || s === "error" || s === "declined") return { ok: false };
  if (s === "cancelled" || s === "canceled" || s === "interrupted") return { ok: false, reason: "cancelled" };
  if (s === "timed_out" || s === "timeout" || s === "timedout") return { ok: false, reason: "timed_out" };
  return null;
}

export function isActivityRunning(tool?: { ok?: boolean; status?: ActivityStatus } | null): boolean {
  if (!tool) return false;
  if (tool.status) return false;
  return tool.ok === undefined;
}

export function runningTool(title: string): ActivityTool {
  const command = redactCommand(title);
  return { name: firstCommandLine(command), command };
}

export function settledTool(tool: ActivityTool | undefined, status: ActivityStatus): ActivityTool {
  const name = redactCommand(tool?.name ?? "tool");
  return {
    name,
    ...(tool?.command ? { command: redactCommand(tool.command) } : {}),
    status,
    ok: status === "completed",
  };
}

/** Instant terminal chip (comms / create-bot notes). */
export function completedNote(name: string): ActivityTool {
  return { name: redactCommand(name), ok: true, status: "completed" };
}

export function failedNote(name: string, status: ActivityStatus = "failed"): ActivityTool {
  return { name: redactCommand(name), ok: false, status };
}

export function itemKey(threadId: string, itemId: string): string {
  return `${threadId}\u0000${itemId}`;
}

export type ActivityIndex = {
  byItem: Map<string, { threadId: string; messageId: string }>;
  pending: Map<string, ActivityOutcome>;
};

export function createActivityIndex(): ActivityIndex {
  return { byItem: new Map(), pending: new Map() };
}

export function takePendingCompletion(
  index: ActivityIndex,
  threadId: string,
  itemId: string | undefined,
): ActivityOutcome | null {
  if (!itemId) return null;
  const key = itemKey(threadId, itemId);
  const pending = index.pending.get(key);
  if (!pending) return null;
  index.pending.delete(key);
  return pending;
}

export function trackOpenTool(
  index: ActivityIndex,
  threadId: string,
  itemId: string | undefined,
  messageId: string,
): void {
  if (!itemId) return;
  index.byItem.set(itemKey(threadId, itemId), { threadId, messageId });
}

/** Returns the open message id, or stashes the outcome if start has not arrived yet. */
export function rememberToolCompletion(
  index: ActivityIndex,
  threadId: string,
  itemId: string,
  outcome: ActivityOutcome,
): string | null {
  const key = itemKey(threadId, itemId);
  const open = index.byItem.get(key);
  if (open) {
    index.byItem.delete(key);
    return open.messageId;
  }
  index.pending.set(key, outcome);
  return null;
}

export function releaseThreadItems(index: ActivityIndex, threadId: string): string[] {
  const ids: string[] = [];
  for (const [key, value] of index.byItem) {
    if (value.threadId === threadId) {
      ids.push(value.messageId);
      index.byItem.delete(key);
    }
  }
  for (const key of [...index.pending.keys()]) {
    if (key.startsWith(`${threadId}\u0000`)) index.pending.delete(key);
  }
  return ids;
}

export function runningActivities<T extends { id: string; kind: string; tool?: ActivityTool }>(
  messages: T[],
): Array<{ id: string; tool: ActivityTool }> {
  return messages
    .filter((m): m is T & { tool: ActivityTool } => m.kind === "activity" && isActivityRunning(m.tool))
    .map((m) => ({ id: m.id, tool: m.tool }));
}
