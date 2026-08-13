// Workspace-global approval rules. First Allow for a tool writes a
// (tool, "*") rule shared by every bot in this install; later permission
// asks that match auto-resolve with source "rule". Per-bot files from
// older builds still match as a fallback. Secrets are stripped before a
// pattern is stored. No cloud policy.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { DATA_DIR } from "./config.ts";
import { newId } from "./contracts.ts";

export type RuleAction = "allow" | "deny";

export interface ApprovalRule {
  id: string;
  tool: string;
  pattern: string;
  action: RuleAction;
  createdAt: number;
}

const RULES_DIR = join(DATA_DIR, "approvals");
/** Disk key for install-wide rules. Not a bot id (those are UUIDs). */
export const WORKSPACE_SCOPE = "_workspace";

function rulesPath(scope: string): string {
  mkdirSync(RULES_DIR, { recursive: true });
  return join(RULES_DIR, `${scope}.json`);
}

export function loadRules(scope: string): ApprovalRule[] {
  try {
    const raw: unknown = JSON.parse(readFileSync(rulesPath(scope), "utf8"));
    if (!Array.isArray(raw)) return [];
    return raw.filter(isRule);
  } catch {
    return [];
  }
}

function isRule(v: unknown): v is ApprovalRule {
  if (!v || typeof v !== "object") return false;
  const r = v as Partial<ApprovalRule>;
  return (
    typeof r.id === "string" &&
    typeof r.tool === "string" &&
    typeof r.pattern === "string" &&
    (r.action === "allow" || r.action === "deny") &&
    Number.isFinite(r.createdAt)
  );
}

function saveRules(scope: string, rules: ApprovalRule[]): void {
  writeFileSync(rulesPath(scope), JSON.stringify(rules, null, 2));
}

/** Strip values that look like keys/tokens before they hit disk or logs. */
export function redactSecrets(text: string): string {
  return text
    .replace(/\b(sk|xai|ghp|gho|github_pat|ak|ck|xoxb|xoxp|xoxa)-[A-Za-z0-9_-]+/gi, "$1-[redacted]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\b(api[_-]?key|token|secret|password|passwd)\b\s*[:=]\s*\S+/gi, "$1=[redacted]");
}

/** Argument pattern stored with a rule — redacted, capped, no raw keys. */
export function argumentPattern(summary: string): string {
  return redactSecrets(summary).trim().slice(0, 200);
}

export function globMatch(value: string, pattern: string): boolean {
  if (!pattern || pattern === "*") return true;
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "s").test(value);
}

function matchingRule(rules: ApprovalRule[], tool: string, summary: string): ApprovalRule | null {
  const haystack = redactSecrets(summary);
  for (const rule of rules) {
    if (rule.tool !== tool) continue;
    if (globMatch(haystack, rule.pattern)) return rule;
  }
  return null;
}

export function matchRule(botId: string, tool: string, summary: string): ApprovalRule | null {
  return matchingRule(loadRules(WORKSPACE_SCOPE), tool, summary) ?? matchingRule(loadRules(botId), tool, summary);
}

export function addRule(
  scope: string,
  input: { tool: string; pattern: string; action: RuleAction },
): ApprovalRule {
  const rule: ApprovalRule = {
    id: newId(),
    tool: input.tool,
    pattern: argumentPattern(input.pattern),
    action: input.action,
    createdAt: Date.now(),
  };
  const rules = loadRules(scope);
  const dup = rules.find((r) => r.tool === rule.tool && r.pattern === rule.pattern && r.action === rule.action);
  if (dup) return dup;
  rules.push(rule);
  saveRules(scope, rules);
  return rule;
}

/** First Allow for a tool: workspace-global, any args, every bot. */
export function alwaysAllow(_botId: string, tool: string, _summary: string): ApprovalRule {
  return addRule(WORKSPACE_SCOPE, { tool, pattern: "*", action: "allow" });
}

export function deleteRule(botId: string, ruleId: string): boolean {
  for (const scope of [WORKSPACE_SCOPE, botId]) {
    const rules = loadRules(scope);
    const next = rules.filter((r) => r.id !== ruleId);
    if (next.length === rules.length) continue;
    saveRules(scope, next);
    return true;
  }
  return false;
}

/** List for the settings UI — workspace + legacy per-bot; secrets re-redacted. */
export function listRules(botId: string): ApprovalRule[] {
  const seen = new Set<string>();
  const out: ApprovalRule[] = [];
  for (const rule of [...loadRules(WORKSPACE_SCOPE), ...loadRules(botId)]) {
    if (seen.has(rule.id)) continue;
    seen.add(rule.id);
    out.push({ ...rule, pattern: redactSecrets(rule.pattern) });
  }
  return out;
}

/** Harness decision for a permission ask (not questions). */
export function resolveOpenedRequest(
  botId: string,
  tool: string,
  summary: string,
): { behavior: RuleAction; source: "rule" } | null {
  const rule = matchRule(botId, tool, summary);
  if (!rule) return null;
  return { behavior: rule.action, source: "rule" };
}

/** Skip stored Allow when the bot's Require-approval toggle is on. */
export function autoResolvePermission(
  bot: { id: string; requireApproval?: boolean },
  tool: string,
  summary: string,
): { behavior: RuleAction; source: "rule" } | null {
  if (bot.requireApproval === true) return null;
  return resolveOpenedRequest(bot.id, tool, summary);
}
