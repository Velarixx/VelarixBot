/** Project the existing chat/activity/workflow fields into a run inspector.
 * No new store, events, or vendor surface — only values already on the
 * bot, transcript, and assigned-task projection, redacted before return. */

import { isActiveQueueTask, type AgentTask } from "./agent-task";
import {
  ACTIVITY_STATUS_LABEL,
  activityStatusOf,
  commandLabel,
  redactCommand,
  type ActivityToolView,
} from "./chat-message";
import { stateLabel, type BotState } from "./product";
import { waitingLabel, workflowLabel, type WorkflowStatus, type WorkflowWaitingFor } from "./workflow";

export type RunInspectorMessage = {
  role: "bot" | "user";
  kind: string;
  text?: string;
  tool?: ActivityToolView;
  at: number;
  from?: { botId: string; name: string };
  report?: {
    kind: "progress" | "blocker" | "completion" | "handoff";
    fromBotId: string;
  };
};

export type RunInspectorInput = {
  botId: string;
  busy: boolean;
  state: BotState;
  stateDetail?: string;
  workflowStatus?: WorkflowStatus;
  workflowWaitingFor?: WorkflowWaitingFor[];
  workflowStopReason?: string;
  messages: RunInspectorMessage[];
  tasks: AgentTask[];
  now: number;
  since: number;
};

export type RunInspectorFields = {
  active: boolean;
  pillLabel: string;
  status?: string;
  activity?: string;
  elapsedSeconds: number;
  delegated?: string;
  blocked?: string;
  outcome?: string;
};

export function runStartedAt(messages: Array<{ role: string; at: number }>, fallback: number): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") return messages[i]!.at;
  }
  return fallback;
}

export function elapsedSeconds(since: number, until: number): number {
  return Math.max(0, Math.round((until - since) / 1000));
}

export function workingLabel(seconds: number): string {
  return `Working for ${seconds}s`;
}

function lastOf<T>(items: T[], pred: (item: T) => boolean): T | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item && pred(item)) return item;
  }
  return undefined;
}

function sanitized(text: string | undefined): string | undefined {
  const value = redactCommand((text ?? "").trim());
  return value || undefined;
}

function latestActivityLine(messages: RunInspectorMessage[]): string | undefined {
  const message = lastOf(messages, (item) => item.kind === "activity" && Boolean(item.tool));
  if (!message?.tool) return undefined;
  const name = sanitized(message.tool.name);
  const line = sanitized(commandLabel(message.tool));
  if (name && line && name !== line) return `${name} · ${line}`;
  return line ?? name;
}

function latestStatus(input: RunInspectorInput): string | undefined {
  const assigned = input.tasks.filter((task) => task.assigneeBotId === input.botId);
  const current = lastOf(assigned, (task) => isActiveQueueTask(task, input.now));
  if (current?.assignment) return sanitized(current.assignment);

  const progress = lastOf(
    input.messages,
    (item) => item.report?.kind === "progress" && Boolean(item.text || item.tool?.name),
  );
  if (progress) return sanitized(progress.text ?? progress.tool?.name);

  if (input.workflowStatus) {
    return sanitized(workflowLabel(input.workflowStatus, input.workflowWaitingFor));
  }
  if (input.stateDetail) return sanitized(input.stateDetail);
  if (input.state && input.state !== "IDLE") return sanitized(stateLabel(input.state));
  return undefined;
}

function delegatedState(input: RunInspectorInput): string | undefined {
  const waiting = input.workflowWaitingFor?.filter((item) => item.botId || item.name.trim());
  if (waiting?.length) {
    const names = waiting
      .map((item) => item.name.trim())
      .filter(Boolean)
      .map((name) => redactCommand(name));
    if (names.length) return sanitized(waitingLabel(waiting.map((item, i) => ({ ...item, name: names[i] ?? item.name }))));
    return sanitized(waitingLabel(waiting));
  }

  const child = lastOf(
    input.tasks,
    (task) => task.fromBotId === input.botId && task.assigneeBotId !== input.botId,
  );
  if (child) {
    const assignment = sanitized(child.assignment);
    const who = sanitized(child.fromName);
    if (assignment && who) return `${who} · ${assignment}`;
    return assignment ?? who;
  }

  const report = lastOf(
    input.messages,
    (item) => Boolean(item.report && item.report.fromBotId !== input.botId && (item.from?.name || item.text)),
  );
  if (report) {
    const who = sanitized(report.from?.name);
    const body = sanitized(report.text ?? report.tool?.name);
    if (who && body) return `${who} · ${body}`;
    return who ?? body;
  }
  return undefined;
}

function blockedState(input: RunInspectorInput): string | undefined {
  const blockerReport = lastOf(input.messages, (item) => item.report?.kind === "blocker");
  if (blockerReport) return sanitized(blockerReport.text ?? blockerReport.tool?.name);

  const assigned = input.tasks.filter((task) => task.assigneeBotId === input.botId || task.fromBotId === input.botId);
  const blockedTask = lastOf(assigned, (task) => Boolean(task.blocker?.trim()));
  if (blockedTask?.blocker) return sanitized(blockedTask.blocker);

  if (input.workflowStatus === "waiting" || input.workflowStatus === "blocked" || input.workflowStatus === "needs_input") {
    return sanitized(input.workflowStopReason || workflowLabel(input.workflowStatus, input.workflowWaitingFor));
  }
  if (input.state === "BLOCKED" || input.state === "NEEDS_INPUT") {
    return sanitized(input.stateDetail || stateLabel(input.state));
  }
  return undefined;
}

function terminalOutcome(input: RunInspectorInput): string | undefined {
  if (input.busy) return undefined;
  if (input.workflowStatus === "completed") return sanitized(workflowLabel("completed"));
  if (input.workflowStatus === "paused") return sanitized(input.workflowStopReason || workflowLabel("paused"));
  if (input.workflowStatus === "blocked") return sanitized(input.workflowStopReason || workflowLabel("blocked"));
  if (input.workflowStatus === "needs_input") return sanitized(workflowLabel("needs_input"));

  const report = lastOf(input.messages, (item) => Boolean(item.report));
  if (report?.report?.kind === "completion") return "Completed";
  if (report?.report?.kind === "blocker") return "Blocked";
  if (report?.report?.kind === "handoff") return "Handoff";

  const activity = lastOf(input.messages, (item) => item.kind === "activity" && Boolean(item.tool));
  if (activity?.tool) {
    const status = activityStatusOf(activity.tool);
    if (status !== "running") return ACTIVITY_STATUS_LABEL[status];
  }

  if (input.state === "DONE") return sanitized(stateLabel("DONE"));
  if (input.state === "BLOCKED") return sanitized(input.stateDetail || stateLabel("BLOCKED"));
  if (input.state === "NEEDS_INPUT") return sanitized(stateLabel("NEEDS_INPUT"));
  if (input.workflowStopReason) return sanitized(input.workflowStopReason);
  return sanitized(stateLabel(input.state));
}

function settleAt(messages: RunInspectorMessage[], since: number, now: number, busy: boolean): number {
  if (busy) return now;
  const last = lastOf(messages, (item) => item.at >= since);
  return last?.at ?? since;
}

export function projectRunInspector(input: RunInspectorInput): RunInspectorFields {
  const until = settleAt(input.messages, input.since, input.now, input.busy);
  const seconds = elapsedSeconds(input.since, until);
  const active = input.busy;
  const outcome = terminalOutcome(input);
  return {
    active,
    pillLabel: active ? workingLabel(seconds) : (outcome ?? "Done"),
    status: latestStatus(input),
    activity: latestActivityLine(input.messages),
    elapsedSeconds: seconds,
    delegated: delegatedState(input),
    blocked: blockedState(input),
    outcome,
  };
}

export function hasInspectableRun(input: { busy?: boolean; messages: Array<{ role: string }> }): boolean {
  return input.busy === true || input.messages.some((item) => item.role === "user");
}
