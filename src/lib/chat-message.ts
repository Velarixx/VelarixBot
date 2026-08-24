import { redactSecrets } from "../../server/redact-text";

export type ActivityStatus = "completed" | "failed" | "cancelled" | "timed_out";

export const COMMAND_COLLAPSE_CHARS = 80;

export interface ActivityToolView {
  name: string;
  ok?: boolean;
  status?: ActivityStatus;
  command?: string;
}

export function splitAttachedFiles(text: string): { body: string; paths: string[] } {
  const match = /(?:^|\n\n)Attached files:\n((?:- [^\n]+(?:\n|$))+)$/.exec(text);
  if (!match) return { body: text, paths: [] };
  const paths = match[1]
    .split(/\r?\n/)
    .map((line) => line.replace(/^- /, "").trim())
    .filter(Boolean);
  if (!paths.length) return { body: text, paths: [] };
  const body = text.slice(0, match.index).trimEnd();
  return { body, paths };
}

export function attachmentDisplayName(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean);
  return parts.at(-1) || path;
}

export function redactCommand(text: string): string {
  return redactSecrets(text);
}

export function visibleCommand(tool: ActivityToolView): string {
  return redactCommand(tool.command ?? tool.name);
}

export function commandLabel(tool: ActivityToolView): string {
  const command = visibleCommand(tool);
  return command.split(/\r?\n/, 1)[0] || tool.name;
}

export function commandNeedsExpand(tool: ActivityToolView): boolean {
  const command = visibleCommand(tool);
  return command.includes("\n") || command.length > COMMAND_COLLAPSE_CHARS;
}

export function isActivityRunning(tool?: { name?: string; ok?: boolean; status?: ActivityStatus } | null): boolean {
  if (!tool) return false;
  if (tool.status) return false;
  return tool.ok === undefined;
}

export function activityStatusOf(tool: ActivityToolView): ActivityStatus | "running" {
  if (tool.status) return tool.status;
  if (tool.ok === true) return "completed";
  if (tool.ok === false) return "failed";
  return "running";
}

export const ACTIVITY_STATUS_LABEL: Record<ActivityStatus | "running", string> = {
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  timed_out: "Timed out",
};
