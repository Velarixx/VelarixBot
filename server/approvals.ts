// Per-bot approval rules. Always-allow writes a (tool, argument pattern)
// rule; later permission asks that match auto-resolve with source "rule".
// Secrets are stripped before a pattern is stored. No cloud policy.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

function rulesPath(botId: string): string {
  mkdirSync(RULES_DIR, { recursive: true });
  return join(RULES_DIR, `${botId}.json`);
}

export function loadRules(botId: string): ApprovalRule[] {
  try {
    const raw: unknown = JSON.parse(readFileSync(rulesPath(botId), "utf8"));
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

function saveRules(botId: string, rules: ApprovalRule[]): void {
  writeFileSync(rulesPath(botId), JSON.stringify(rules, null, 2));
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
  return new RegExp(`^${escaped}$`, "s").test(value) || value.includes(pattern);
}

export function matchRule(botId: string, tool: string, summary: string): ApprovalRule | null {
  const haystack = redactSecrets(summary);
  for (const rule of loadRules(botId)) {
    if (rule.tool !== tool) continue;
    if (globMatch(haystack, rule.pattern)) return rule;
  }
  return null;
}

export function addRule(
  botId: string,
  input: { tool: string; pattern: string; action: RuleAction },
): ApprovalRule {
  const rule: ApprovalRule = {
    id: newId(),
    tool: input.tool,
    pattern: argumentPattern(input.pattern),
    action: input.action,
    createdAt: Date.now(),
  };
  const rules = loadRules(botId);
  const dup = rules.find((r) => r.tool === rule.tool && r.pattern === rule.pattern && r.action === rule.action);
  if (dup) return dup;
  rules.push(rule);
  saveRules(botId, rules);
  return rule;
}

export function alwaysAllow(botId: string, tool: string, summary: string): ApprovalRule {
  return addRule(botId, { tool, pattern: argumentPattern(summary) || "*", action: "allow" });
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

export function rulesFileExists(botId: string): boolean {
  return existsSync(rulesPath(botId));
}
