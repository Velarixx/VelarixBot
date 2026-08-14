// approval_rules / approval_audit / skills / memory tables.
//
// Runtime reads and writes for these domains stay on their existing tested
// modules (approvals.ts, teach.ts, memory.ts — P0.1/P0.2 behavior, pinned
// by their suites). These tables are the SQLite copy of that state: filled
// by the legacy importer and refreshed from the file modules on every boot
// (rerunnable, idempotent), so the one database file — and its NDJSON
// export — always carries the complete workspace.
import type { ApprovalRule, AuditEntry } from "../approvals.ts";
import type { SkillRecord } from "../teach.ts";
import type { SqliteDatabase } from "../db/sqlite-native.ts";

export interface ScopedRule {
  scope: string;
  rule: ApprovalRule;
}

export interface MemoryRow {
  owner: string;
  user: string;
  distilled: string;
  updatedAt: number;
}

export interface SnapshotsRepository {
  replaceApprovalRules(rules: ScopedRule[]): void;
  listApprovalRules(): ScopedRule[];
  replaceApprovalAudit(entries: AuditEntry[]): void;
  listApprovalAudit(): AuditEntry[];
  replaceSkills(skills: SkillRecord[]): void;
  listSkills(): SkillRecord[];
  replaceMemory(rows: MemoryRow[]): void;
  listMemory(): MemoryRow[];
}

interface RuleRow {
  scope: string;
  id: string;
  tool: string;
  pattern: string;
  action: string;
  created_at: number;
  disabled: number;
  quarantined: number;
  confirmed: number;
}

interface AuditRow {
  at: number;
  bot: string;
  tool: string;
  matcher: string;
  decision: string;
  rule_id: string | null;
}

interface SkillRow {
  id: string;
  name: string;
  bot_id: string;
  markdown: string;
  created_at: number;
}

interface MemoryTableRow {
  owner: string;
  user_text: string;
  distilled_text: string;
  updated_at: number;
}

export function createSnapshotsRepository(db: SqliteDatabase): SnapshotsRepository {
  const clearRules = db.prepare("DELETE FROM approval_rules");
  const insertRule = db.prepare(
    "INSERT INTO approval_rules(scope, id, tool, pattern, action, created_at, disabled, quarantined, confirmed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const selectRules = db.prepare<RuleRow>(
    "SELECT scope, id, tool, pattern, action, created_at, disabled, quarantined, confirmed FROM approval_rules ORDER BY scope, created_at, id",
  );
  const clearAudit = db.prepare("DELETE FROM approval_audit");
  const insertAudit = db.prepare("INSERT INTO approval_audit(at, bot, tool, matcher, decision, rule_id) VALUES (?, ?, ?, ?, ?, ?)");
  const selectAudit = db.prepare<AuditRow>("SELECT at, bot, tool, matcher, decision, rule_id FROM approval_audit ORDER BY seq");
  const clearSkills = db.prepare("DELETE FROM skills");
  const insertSkill = db.prepare("INSERT INTO skills(id, name, bot_id, markdown, created_at) VALUES (?, ?, ?, ?, ?)");
  const selectSkills = db.prepare<SkillRow>("SELECT id, name, bot_id, markdown, created_at FROM skills ORDER BY created_at, id");
  const clearMemory = db.prepare("DELETE FROM memory");
  const insertMemory = db.prepare("INSERT INTO memory(owner, user_text, distilled_text, updated_at) VALUES (?, ?, ?, ?)");
  const selectMemory = db.prepare<MemoryTableRow>("SELECT owner, user_text, distilled_text, updated_at FROM memory ORDER BY owner");

  const replaceRulesTx = db.transaction((rules: ScopedRule[]) => {
    clearRules.run();
    for (const { scope, rule } of rules) {
      insertRule.run(
        scope,
        rule.id,
        rule.tool,
        rule.pattern,
        rule.action,
        rule.createdAt,
        rule.disabled === true ? 1 : 0,
        rule.quarantined === true ? 1 : 0,
        rule.confirmed === true ? 1 : 0,
      );
    }
  });
  const replaceAuditTx = db.transaction((entries: AuditEntry[]) => {
    clearAudit.run();
    for (const entry of entries) {
      insertAudit.run(entry.at, entry.bot, entry.tool, entry.matcher, entry.decision, entry.ruleId ?? null);
    }
  });
  const replaceSkillsTx = db.transaction((skills: SkillRecord[]) => {
    clearSkills.run();
    for (const skill of skills) insertSkill.run(skill.id, skill.name, skill.botId, skill.markdown, skill.createdAt);
  });
  const replaceMemoryTx = db.transaction((rows: MemoryRow[]) => {
    clearMemory.run();
    for (const row of rows) insertMemory.run(row.owner, row.user, row.distilled, row.updatedAt);
  });

  return {
    replaceApprovalRules: (rules) => replaceRulesTx(rules),
    listApprovalRules() {
      return selectRules.all().map((row) => ({
        scope: row.scope,
        rule: {
          id: row.id,
          tool: row.tool,
          pattern: row.pattern,
          action: row.action as ApprovalRule["action"],
          createdAt: row.created_at,
          ...(row.disabled ? { disabled: true } : {}),
          ...(row.quarantined ? { quarantined: true } : {}),
          ...(row.confirmed ? { confirmed: true } : {}),
        },
      }));
    },
    replaceApprovalAudit: (entries) => replaceAuditTx(entries),
    listApprovalAudit() {
      return selectAudit.all().map((row) => ({
        at: row.at,
        bot: row.bot,
        tool: row.tool,
        matcher: row.matcher,
        decision: row.decision,
        ...(row.rule_id ? { ruleId: row.rule_id } : {}),
      }));
    },
    replaceSkills: (skills) => replaceSkillsTx(skills),
    listSkills() {
      return selectSkills.all().map((row) => ({
        id: row.id,
        name: row.name,
        botId: row.bot_id,
        markdown: row.markdown,
        createdAt: row.created_at,
      }));
    },
    replaceMemory: (rows) => replaceMemoryTx(rows),
    listMemory() {
      return selectMemory.all().map((row) => ({
        owner: row.owner,
        user: row.user_text,
        distilled: row.distilled_text,
        updatedAt: row.updated_at,
      }));
    },
  };
}
