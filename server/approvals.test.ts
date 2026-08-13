import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import {
  addRule,
  alwaysAllow,
  argumentPattern,
  autoResolvePermission,
  deleteRule,
  globMatch,
  listRules,
  loadRules,
  matchRule,
  redactSecrets,
  resolveOpenedRequest,
  WORKSPACE_SCOPE,
} from "./approvals.ts";

const BOT = "bot-approve-1";
const OTHER = "bot-approve-2";

beforeEach(() => {
  rmSync(join(DATA_DIR, "approvals"), { recursive: true, force: true });
  mkdirSync(DATA_DIR, { recursive: true });
});

describe("approval rules", () => {
  it("stores a workspace-global Allow that auto-resolves later asks for every bot", () => {
    alwaysAllow(BOT, "list_bots", 'Allow the agents MCP server to run tool "list_bots"?');
    expect(loadRules(WORKSPACE_SCOPE)).toEqual([
      expect.objectContaining({ tool: "list_bots", pattern: "*", action: "allow" }),
    ]);
    expect(loadRules(BOT)).toEqual([]);
    expect(matchRule(BOT, "list_bots", "a different elicitation summary")?.action).toBe("allow");
    expect(resolveOpenedRequest(OTHER, "list_bots", "ask again")).toEqual({ behavior: "allow", source: "rule" });
    expect(resolveOpenedRequest(OTHER, "ask_bot", "ask a peer")).toBeNull();
    expect(resolveOpenedRequest(BOT, "Bash", "git status")).toBeNull();
  });

  it("Always allow writes a workspace rule; deny rules auto-deny", () => {
    const written = alwaysAllow(BOT, "shell", "ls -la /tmp");
    expect(written.action).toBe("allow");
    expect(loadRules(WORKSPACE_SCOPE)).toHaveLength(1);
    expect(resolveOpenedRequest(OTHER, "shell", "rm -rf scratch")?.behavior).toBe("allow");

    addRule(BOT, { tool: "shell", pattern: "rm -rf *", action: "deny" });
    expect(resolveOpenedRequest(BOT, "shell", "rm -rf scratch")?.behavior).toBe("allow");
    addRule(WORKSPACE_SCOPE, { tool: "edit", pattern: "*", action: "deny" });
    expect(resolveOpenedRequest(OTHER, "edit", "src/index.ts")?.behavior).toBe("deny");
  });

  it("does not store raw keys in patterns", () => {
    const pattern = argumentPattern('curl -H "Authorization: Bearer sk-live-supersecret" https://api');
    expect(pattern).not.toContain("sk-live-supersecret");
    expect(pattern).toContain("[redacted]");
    alwaysAllow(BOT, "Bash", "XAI_API_KEY=xai-abc123restofkey /usr/bin/env");
    const stored = loadRules(WORKSPACE_SCOPE)[0]?.pattern ?? "";
    expect(stored).toBe("*");
    expect(JSON.stringify(loadRules(WORKSPACE_SCOPE))).not.toContain("xai-abc123restofkey");
    expect(redactSecrets("token=ghp-not-a-real-token")).toContain("[redacted]");
  });

  it("glob * matches any args for that tool", () => {
    addRule(BOT, { tool: "Read", pattern: "*", action: "allow" });
    expect(resolveOpenedRequest(BOT, "Read", "src/index.ts")?.source).toBe("rule");
  });

  it("does not treat a substring as a match", () => {
    addRule(BOT, { tool: "Bash", pattern: "git status", action: "allow" });
    expect(globMatch("prefix git status suffix", "git status")).toBe(false);
    expect(resolveOpenedRequest(BOT, "Bash", "prefix git status suffix")).toBeNull();
    expect(resolveOpenedRequest(BOT, "Bash", "git status")?.behavior).toBe("allow");
  });

  it("lists and revokes workspace rules without echoing raw secrets", () => {
    const written = alwaysAllow(BOT, "Bash", "token=sk-live-supersecret git status");
    const listed = listRules(OTHER);
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain("sk-live-supersecret");
    expect(listed[0]?.pattern).toBe("*");
    expect(deleteRule(OTHER, written.id)).toBe(true);
    expect(listRules(BOT)).toEqual([]);
    expect(deleteRule(BOT, written.id)).toBe(false);
  });

  it("Require approval skips stored workspace Allow", () => {
    alwaysAllow(BOT, "list_bots", "Allow list_bots");
    expect(autoResolvePermission({ id: OTHER }, "list_bots", "again")).toEqual({
      behavior: "allow",
      source: "rule",
    });
    expect(autoResolvePermission({ id: OTHER, requireApproval: true }, "list_bots", "again")).toBeNull();
  });
});
