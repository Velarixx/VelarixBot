// Scoped approval rules with explicit consent.
//
//   Allow once                → persists nothing.
//   Always allow for this bot → per-bot rule: explicit tool + redacted matcher.
//   Advanced: all bots        → the ONLY path that writes the shared
//                               "_workspace" scope — still an explicit
//                               matcher, never an auto-generated "*".
//
// Deny is never persisted. Credential/sign-in asks are never auto-resolved
// by rules. Legacy workspace-wide and wildcard rules (the PR #60 shape,
// where one Allow click became a permanent install-wide grant) are
// quarantined to a disabled state on boot until reconfirmed in Settings —
// idempotently, so a reconfirmed rule is never re-quarantined. Every
// decision lands in an append-only audit log. Secrets are stripped before
// a matcher hits disk or logs. No cloud policy.
import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { atomicWriteFileSync, ensurePrivateDir, PRIVATE_FILE_MODE } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import { newId } from "./contracts.ts";
import { isCredentialAsk } from "./handoff.ts";

export type RuleAction = "allow" | "deny";

export interface ApprovalRule {
  id: string;
  tool: string;
  pattern: string;
  action: RuleAction;
  createdAt: number;
  /** Disabled rules never match. Set by quarantine, cleared by reconfirm. */
  disabled?: boolean;
  /** Legacy workspace/wildcard rule parked pending reconfirmation in Settings. */
  quarantined?: boolean;
  /** Explicit consent: written by the new flows or a Settings reconfirm.
   * Confirmed rules are never quarantined again. */
  confirmed?: boolean;
}

const RULES_DIR = join(DATA_DIR, "approvals");
const AUDIT_FILE = "audit.jsonl";
/** Disk key for install-wide rules. Not a bot id (those are UUIDs). */
export const WORKSPACE_SCOPE = "_workspace";

function rulesPath(scope: string): string {
  ensurePrivateDir(RULES_DIR);
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
  atomicWriteFileSync(rulesPath(scope), JSON.stringify(rules, null, 2));
}

/** Strip values that look like keys/tokens before they hit disk or logs. */
export function redactSecrets(text: string): string {
  return text
    .replace(/\b(sk|xai|ghp|gho|github_pat|ak|ck|xoxb|xoxp|xoxa)-[A-Za-z0-9_-]+/gi, "$1-[redacted]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\b(api[_-]?key|token|secret|password|passwd)\b\s*[:=]\s*\S+/gi, "$1=[redacted]");
}

/** Argument pattern stored with a rule — redacted, capped, no raw keys. */
export const MATCHER_MAX = 200;

export function argumentPattern(summary: string): string {
  return redactSecrets(summary).trim().slice(0, MATCHER_MAX);
}

export function globMatch(value: string, pattern: string): boolean {
  if (!pattern || pattern === "*") return true;
  // `?` must be escaped: an unescaped `?` makes the preceding char optional
  // and silently widens a stored Allow matcher.
  const escaped = pattern.replace(/[.+^${}()|[\]\\?]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "s").test(value);
}

function matchingRule(rules: ApprovalRule[], tool: string, summary: string): ApprovalRule | null {
  // Cap the haystack identically to the stored matcher. Always-allow on a
  // summary > MATCHER_MAX must still match after persist (anchored ^…$).
  const haystack = argumentPattern(summary);
  for (const rule of rules) {
    if (rule.disabled === true) continue;
    if (rule.tool !== tool) continue;
    if (globMatch(haystack, rule.pattern)) return rule;
  }
  return null;
}

/** Workspace rules (explicit "Advanced: all bots" consent) apply to every
 * bot; per-bot rules apply only to that bot. Disabled rules never match. */
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
    confirmed: true,
  };
  const rules = loadRules(scope);
  const dup = rules.find((r) => r.tool === rule.tool && r.pattern === rule.pattern && r.action === rule.action);
  if (dup) return dup;
  rules.push(rule);
  saveRules(scope, rules);
  return rule;
}

export type PersistScope = "bot" | "workspace";

/** The ONLY path that persists a rule from a permission answer. Returns
 * null (persists nothing) unless the client explicitly asked to persist an
 * Allow: plain Allow-once, any Deny, credential/sign-in asks, and empty or
 * wildcard matchers all persist nothing. Default scope is the current bot;
 * "workspace" is the explicit Advanced: all-bots consent. */
export function persistAllowRule(input: {
  botId: string;
  tool: string;
  summary: string;
  behavior: string;
  always: boolean;
  scope?: PersistScope;
  requestType?: string;
}): ApprovalRule | null {
  if (input.always !== true || input.behavior !== "allow") return null;
  if (isCredentialAsk(input.requestType ?? "permission", input.tool, input.summary)) return null;
  const matcher = argumentPattern(input.summary);
  if (!input.tool.trim() || !matcher || matcher === "*") return null; // never auto-generate a wildcard
  const workspace = input.scope === "workspace";
  const rule = addRule(workspace ? WORKSPACE_SCOPE : input.botId, {
    tool: input.tool,
    pattern: matcher,
    action: "allow",
  });
  appendAudit({
    bot: input.botId,
    tool: input.tool,
    matcher: rule.pattern,
    decision: workspace ? "persist.workspace" : "persist.bot",
    ruleId: rule.id,
  });
  return rule;
}

function needsQuarantine(scope: string, rule: ApprovalRule): boolean {
  if (rule.confirmed === true || rule.quarantined === true) return false;
  return scope === WORKSPACE_SCOPE || !rule.pattern || rule.pattern === "*";
}

/** Boot migration for the consent bug: park every legacy workspace-scope
 * rule and every wildcard rule (any scope) as disabled until the user
 * reconfirms it in Settings. Idempotent — already-quarantined and
 * confirmed rules are never touched again. Returns how many rules were
 * newly quarantined. */
export function quarantineLegacyRules(): number {
  let scopes: string[] = [];
  try {
    scopes = readdirSync(RULES_DIR)
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -".json".length));
  } catch {
    return 0; // no rules dir yet
  }
  let count = 0;
  for (const scope of scopes) {
    const rules = loadRules(scope);
    let changed = false;
    const next = rules.map((rule) => {
      if (!needsQuarantine(scope, rule)) return rule;
      changed = true;
      count++;
      appendAudit({ bot: scope, tool: rule.tool, matcher: rule.pattern, decision: "quarantine", ruleId: rule.id });
      return { ...rule, disabled: true, quarantined: true };
    });
    if (changed) saveRules(scope, next);
  }
  return count;
}

/** Settings reconfirmation of a quarantined rule: re-enables it and marks
 * explicit consent so the next boot's quarantine pass leaves it alone. */
export function confirmRule(botId: string, ruleId: string): ApprovalRule | null {
  for (const scope of [WORKSPACE_SCOPE, botId]) {
    const rules = loadRules(scope);
    const index = rules.findIndex((r) => r.id === ruleId);
    if (index < 0) continue;
    const next: ApprovalRule = { ...rules[index], confirmed: true };
    delete next.disabled;
    delete next.quarantined;
    rules[index] = next;
    saveRules(scope, rules);
    appendAudit({ bot: botId, tool: next.tool, matcher: next.pattern, decision: "reconfirm", ruleId });
    return next;
  }
  return null;
}

export function deleteRule(botId: string, ruleId: string): boolean {
  for (const scope of [WORKSPACE_SCOPE, botId]) {
    const rules = loadRules(scope);
    const removed = rules.find((r) => r.id === ruleId);
    const next = rules.filter((r) => r.id !== ruleId);
    if (next.length === rules.length) continue;
    saveRules(scope, next);
    if (removed) appendAudit({ bot: botId, tool: removed.tool, matcher: removed.pattern, decision: "revoke", ruleId });
    return true;
  }
  return false;
}

/** List for the settings UI — workspace + this bot; secrets re-redacted.
 * Quarantined rules stay visible so Settings can offer reconfirmation. */
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

/** Skip stored Allow when the bot's Require-approval toggle is on, and
 * never auto-resolve credential/sign-in asks no matter what rules exist.
 * The bot's Always-allow settings toggle (`bot.alwaysAllow`) resolves to
 * allow AFTER explicit rules — a stored deny rule still wins — and is
 * scoped to this one bot: it writes no rule, no workspace grant, and no
 * `*` matcher anywhere. Every auto-decision lands in the audit log. */
export function autoResolvePermission(
  bot: { id: string; requireApproval?: boolean; alwaysAllow?: boolean },
  tool: string,
  summary: string,
): { behavior: RuleAction; source: "rule" } | null {
  if (bot.requireApproval === true) return null;
  if (isCredentialAsk("permission", tool, summary)) return null;
  const rule = matchRule(bot.id, tool, summary);
  if (rule) {
    appendAudit({ bot: bot.id, tool, matcher: rule.pattern, decision: `rule.${rule.action}`, ruleId: rule.id });
    return { behavior: rule.action, source: "rule" };
  }
  if (bot.alwaysAllow === true) {
    appendAudit({ bot: bot.id, tool, matcher: argumentPattern(summary), decision: "bot.always-allow" });
    return { behavior: "allow", source: "rule" };
  }
  return null;
}

// ── append-only audit log ────────────────────────────────────────────────
export interface AuditEntry {
  at: number;
  bot: string;
  tool: string;
  matcher: string;
  decision: string;
  ruleId?: string;
}

/** One line per decision: bot, tool, redacted matcher, decision, ruleId. */
export function appendAudit(entry: Omit<AuditEntry, "at">): void {
  ensurePrivateDir(RULES_DIR);
  const line: AuditEntry = {
    at: Date.now(),
    bot: entry.bot,
    tool: entry.tool,
    matcher: redactSecrets(entry.matcher).slice(0, 200),
    decision: entry.decision,
    ...(entry.ruleId ? { ruleId: entry.ruleId } : {}),
  };
  appendFileSync(join(RULES_DIR, AUDIT_FILE), JSON.stringify(line) + "\n", { mode: PRIVATE_FILE_MODE });
}

export function readAudit(): AuditEntry[] {
  try {
    return readFileSync(join(RULES_DIR, AUDIT_FILE), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((row) => JSON.parse(row) as AuditEntry);
  } catch {
    return [];
  }
}
