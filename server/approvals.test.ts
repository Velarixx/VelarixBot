import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import {
  addRule,
  argumentPattern,
  autoResolvePermission,
  confirmRule,
  deleteRule,
  globMatch,
  listRules,
  loadRules,
  matchRule,
  persistAllowRule,
  quarantineLegacyRules,
  readAudit,
  redactSecrets,
  resolveOpenedRequest,
  WORKSPACE_SCOPE,
  type ApprovalRule,
} from "./approvals.ts";

const BOT = "bot-approve-1";
const OTHER = "bot-approve-2";
const RULES_DIR = join(DATA_DIR, "approvals");

beforeEach(() => {
  rmSync(RULES_DIR, { recursive: true, force: true });
  mkdirSync(RULES_DIR, { recursive: true });
});

function legacyRule(overrides: Partial<ApprovalRule>): ApprovalRule {
  return { id: "legacy", tool: "shell", pattern: "*", action: "allow", createdAt: 1, ...overrides };
}

describe("approval persistence consent", () => {
  it("one-time Allow persists nothing", () => {
    const rule = persistAllowRule({ botId: BOT, tool: "shell", summary: "echo hi", behavior: "allow", always: false });
    expect(rule).toBeNull();
    expect(loadRules(BOT)).toEqual([]);
    expect(loadRules(WORKSPACE_SCOPE)).toEqual([]);
    expect(resolveOpenedRequest(BOT, "shell", "echo hi")).toBeNull();
  });

  it("Deny is never persisted, even with always set", () => {
    expect(persistAllowRule({ botId: BOT, tool: "shell", summary: "rm -rf /", behavior: "deny", always: true })).toBeNull();
    expect(loadRules(BOT)).toEqual([]);
    expect(loadRules(WORKSPACE_SCOPE)).toEqual([]);
  });

  it("Always allow for this bot writes a scoped per-bot rule that never fires for another bot", () => {
    const rule = persistAllowRule({ botId: BOT, tool: "shell", summary: "git status", behavior: "allow", always: true });
    expect(rule).toMatchObject({ tool: "shell", pattern: "git status", action: "allow", confirmed: true });
    expect(loadRules(BOT)).toHaveLength(1);
    expect(loadRules(WORKSPACE_SCOPE)).toEqual([]);
    expect(resolveOpenedRequest(BOT, "shell", "git status")).toEqual({ behavior: "allow", source: "rule" });
    // a bot-A rule never fires for bot B
    expect(resolveOpenedRequest(OTHER, "shell", "git status")).toBeNull();
    // and not for a different tool or non-matching args on the same bot
    expect(resolveOpenedRequest(BOT, "edit", "git status")).toBeNull();
    expect(resolveOpenedRequest(BOT, "shell", "git push --force")).toBeNull();
  });

  it("Advanced: all bots is the only path that writes workspace scope, with an explicit matcher", () => {
    const rule = persistAllowRule({
      botId: BOT,
      tool: "shell",
      summary: "npm test",
      behavior: "allow",
      always: true,
      scope: "workspace",
    });
    expect(rule).toMatchObject({ tool: "shell", pattern: "npm test", action: "allow" });
    expect(loadRules(WORKSPACE_SCOPE)).toHaveLength(1);
    expect(loadRules(BOT)).toEqual([]);
    expect(resolveOpenedRequest(OTHER, "shell", "npm test")?.behavior).toBe("allow");
    expect(resolveOpenedRequest(OTHER, "shell", "npm publish")).toBeNull();
  });

  it("never auto-generates a wildcard matcher", () => {
    expect(persistAllowRule({ botId: BOT, tool: "shell", summary: "", behavior: "allow", always: true })).toBeNull();
    expect(persistAllowRule({ botId: BOT, tool: "shell", summary: "   ", behavior: "allow", always: true })).toBeNull();
    expect(persistAllowRule({ botId: BOT, tool: "shell", summary: "*", behavior: "allow", always: true })).toBeNull();
    expect(persistAllowRule({ botId: BOT, tool: " ", summary: "echo hi", behavior: "allow", always: true })).toBeNull();
    expect(loadRules(BOT)).toEqual([]);
    expect(loadRules(WORKSPACE_SCOPE)).toEqual([]);
    for (const rule of [
      persistAllowRule({ botId: BOT, tool: "shell", summary: "echo hi", behavior: "allow", always: true }),
      persistAllowRule({ botId: BOT, tool: "edit", summary: "src/index.ts", behavior: "allow", always: true, scope: "workspace" }),
    ]) {
      expect(rule?.pattern).toBeTruthy();
      expect(rule?.pattern).not.toBe("*");
    }
  });

  it("credential/sign-in asks are never persisted or auto-resolved by rules", () => {
    expect(
      persistAllowRule({ botId: BOT, tool: "shell", summary: "Sign in to GitHub", behavior: "allow", always: true }),
    ).toBeNull();
    expect(
      persistAllowRule({ botId: BOT, tool: "shell", summary: "ok", behavior: "allow", always: true, requestType: "credential" }),
    ).toBeNull();
    expect(loadRules(BOT)).toEqual([]);
    // even a hand-written matching rule must not auto-resolve a sign-in ask
    addRule(BOT, { tool: "shell", pattern: "*password*", action: "allow" });
    expect(autoResolvePermission({ id: BOT }, "shell", "enter the password: hunter2")).toBeNull();
  });
});

describe("legacy quarantine", () => {
  it("parks workspace-scope and wildcard rules as disabled, pending reconfirmation", () => {
    writeFileSync(join(RULES_DIR, `${WORKSPACE_SCOPE}.json`), JSON.stringify([legacyRule({ id: "ws-star" })]));
    writeFileSync(
      join(RULES_DIR, `${BOT}.json`),
      JSON.stringify([
        legacyRule({ id: "bot-star", pattern: "*" }),
        legacyRule({ id: "bot-explicit", pattern: "git status" }),
      ]),
    );
    expect(quarantineLegacyRules()).toBe(2);

    // quarantined rules never match; the explicit per-bot legacy rule survives
    expect(matchRule(BOT, "shell", "anything at all")).toBeNull();
    expect(matchRule(BOT, "shell", "git status")?.id).toBe("bot-explicit");
    expect(matchRule(OTHER, "shell", "anything at all")).toBeNull();

    const listed = listRules(BOT);
    expect(listed.find((r) => r.id === "ws-star")).toMatchObject({ disabled: true, quarantined: true });
    expect(listed.find((r) => r.id === "bot-star")).toMatchObject({ disabled: true, quarantined: true });
    expect(listed.find((r) => r.id === "bot-explicit")?.disabled).toBeUndefined();
  });

  it("is idempotent and never re-quarantines a reconfirmed rule", () => {
    writeFileSync(join(RULES_DIR, `${WORKSPACE_SCOPE}.json`), JSON.stringify([legacyRule({ id: "ws-star" })]));
    expect(quarantineLegacyRules()).toBe(1);
    const afterFirst = readFileSync(join(RULES_DIR, `${WORKSPACE_SCOPE}.json`), "utf8");
    expect(quarantineLegacyRules()).toBe(0);
    expect(readFileSync(join(RULES_DIR, `${WORKSPACE_SCOPE}.json`), "utf8")).toBe(afterFirst);

    const confirmed = confirmRule(BOT, "ws-star");
    expect(confirmed).toMatchObject({ id: "ws-star", confirmed: true });
    expect(confirmed?.disabled).toBeUndefined();
    expect(matchRule(BOT, "shell", "anything")?.id).toBe("ws-star");
    expect(quarantineLegacyRules()).toBe(0);
    expect(matchRule(BOT, "shell", "anything")?.id).toBe("ws-star");
  });

  it("new explicit rules survive the boot quarantine pass", () => {
    persistAllowRule({ botId: BOT, tool: "shell", summary: "echo hi", behavior: "allow", always: true });
    persistAllowRule({ botId: BOT, tool: "edit", summary: "src/x.ts", behavior: "allow", always: true, scope: "workspace" });
    expect(quarantineLegacyRules()).toBe(0);
    expect(resolveOpenedRequest(BOT, "shell", "echo hi")?.behavior).toBe("allow");
    expect(resolveOpenedRequest(OTHER, "edit", "src/x.ts")?.behavior).toBe("allow");
  });
});

describe("approval rules", () => {
  it("deny rules auto-deny for their own scope", () => {
    addRule(BOT, { tool: "shell", pattern: "rm -rf *", action: "deny" });
    expect(resolveOpenedRequest(BOT, "shell", "rm -rf scratch")?.behavior).toBe("deny");
    expect(resolveOpenedRequest(OTHER, "shell", "rm -rf scratch")).toBeNull();
  });

  it("does not store raw keys in patterns", () => {
    const pattern = argumentPattern('curl -H "Authorization: Bearer sk-live-supersecret" https://api');
    expect(pattern).not.toContain("sk-live-supersecret");
    expect(pattern).toContain("[redacted]");
    persistAllowRule({
      botId: BOT,
      tool: "Bash",
      summary: "XAI_API_KEY=xai-abc123restofkey /usr/bin/env",
      behavior: "allow",
      always: true,
    });
    expect(JSON.stringify(loadRules(BOT))).not.toContain("xai-abc123restofkey");
    expect(redactSecrets("token=ghp-not-a-real-token")).toContain("[redacted]");
  });

  it("glob * matches any args for that tool (hand-written rules only)", () => {
    addRule(BOT, { tool: "Read", pattern: "*", action: "allow" });
    expect(resolveOpenedRequest(BOT, "Read", "src/index.ts")?.source).toBe("rule");
  });

  it("does not treat a substring as a match", () => {
    addRule(BOT, { tool: "Bash", pattern: "git status", action: "allow" });
    expect(globMatch("prefix git status suffix", "git status")).toBe(false);
    expect(resolveOpenedRequest(BOT, "Bash", "prefix git status suffix")).toBeNull();
    expect(resolveOpenedRequest(BOT, "Bash", "git status")?.behavior).toBe("allow");
  });

  it("lists and revokes rules without echoing raw secrets", () => {
    const written = persistAllowRule({
      botId: BOT,
      tool: "Bash",
      summary: "token=sk-live-supersecret git status",
      behavior: "allow",
      always: true,
    })!;
    expect(listRules(OTHER)).toEqual([]); // per-bot rule stays out of other bots' lists
    const listed = listRules(BOT);
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain("sk-live-supersecret");
    expect(deleteRule(BOT, written.id)).toBe(true);
    expect(listRules(BOT)).toEqual([]);
    expect(deleteRule(BOT, written.id)).toBe(false);
  });

  it("Require approval skips stored Allow", () => {
    persistAllowRule({ botId: BOT, tool: "list_bots", summary: "Allow list_bots", behavior: "allow", always: true });
    expect(autoResolvePermission({ id: BOT }, "list_bots", "Allow list_bots")).toEqual({
      behavior: "allow",
      source: "rule",
    });
    expect(autoResolvePermission({ id: BOT, requireApproval: true }, "list_bots", "Allow list_bots")).toBeNull();
  });
});

describe("per-bot Always allow settings toggle", () => {
  it("auto-allows routine asks for THIS bot only, without writing any rule", () => {
    expect(autoResolvePermission({ id: BOT, alwaysAllow: true }, "shell", "git status")).toEqual({
      behavior: "allow",
      source: "rule",
    });
    // no rule, no wildcard, no workspace grant lands on disk
    expect(loadRules(BOT)).toEqual([]);
    expect(loadRules(WORKSPACE_SCOPE)).toEqual([]);
    // the toggle is a bot-record flag: another bot without it still cards
    expect(autoResolvePermission({ id: OTHER }, "shell", "git status")).toBeNull();
  });

  it("Require approval wins over Always allow", () => {
    expect(
      autoResolvePermission({ id: BOT, alwaysAllow: true, requireApproval: true }, "shell", "git status"),
    ).toBeNull();
  });

  it("credential/sign-in asks are never auto-resolved by Always allow", () => {
    expect(autoResolvePermission({ id: BOT, alwaysAllow: true }, "shell", "Sign in to GitHub")).toBeNull();
    expect(autoResolvePermission({ id: BOT, alwaysAllow: true }, "shell", "enter the password: hunter2")).toBeNull();
  });

  it("an explicit deny rule still wins over Always allow", () => {
    addRule(BOT, { tool: "shell", pattern: "rm -rf *", action: "deny" });
    expect(autoResolvePermission({ id: BOT, alwaysAllow: true }, "shell", "rm -rf scratch")).toEqual({
      behavior: "deny",
      source: "rule",
    });
    expect(autoResolvePermission({ id: BOT, alwaysAllow: true }, "shell", "git status")?.behavior).toBe("allow");
  });

  it("audits every Always-allow auto-decision with a redacted matcher", () => {
    autoResolvePermission({ id: BOT, alwaysAllow: true }, "shell", "token=sk-live-supersecret git push");
    const entries = readAudit().filter((entry) => entry.decision === "bot.always-allow");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ bot: BOT, tool: "shell" });
    expect(JSON.stringify(entries)).not.toContain("sk-live-supersecret");
  });
});

describe("audit log", () => {
  it("appends redacted, append-only entries for persist, rule hits, quarantine, reconfirm, and revoke", () => {
    const rule = persistAllowRule({
      botId: BOT,
      tool: "Bash",
      summary: "token=sk-live-supersecret git status",
      behavior: "allow",
      always: true,
    })!;
    autoResolvePermission({ id: BOT }, "Bash", "token=sk-live-supersecret git status");
    writeFileSync(join(RULES_DIR, `${WORKSPACE_SCOPE}.json`), JSON.stringify([legacyRule({ id: "ws-star" })]));
    quarantineLegacyRules();
    confirmRule(BOT, "ws-star");
    deleteRule(BOT, rule.id);

    const audit = readAudit();
    const decisions = audit.map((e) => e.decision);
    expect(decisions).toEqual(["persist.bot", "rule.allow", "quarantine", "reconfirm", "revoke"]);
    for (const entry of audit) {
      expect(entry.at).toBeGreaterThan(0);
      expect(entry.bot).toBeTruthy();
      expect(entry.tool).toBeTruthy();
    }
    expect(audit[0].ruleId).toBe(rule.id);
    expect(audit[1].ruleId).toBe(rule.id);
    const raw = readFileSync(join(RULES_DIR, "audit.jsonl"), "utf8");
    expect(raw).not.toContain("sk-live-supersecret");
    expect(raw.trim().split("\n")).toHaveLength(5);
  });
});
