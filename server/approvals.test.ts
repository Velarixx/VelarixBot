import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import {
  addRule,
  alwaysAllow,
  argumentPattern,
  loadRules,
  matchRule,
  redactSecrets,
  resolveOpenedRequest,
} from "./approvals.ts";

const BOT = "bot-approve-1";

beforeEach(() => {
  rmSync(join(DATA_DIR, "approvals"), { recursive: true, force: true });
  mkdirSync(DATA_DIR, { recursive: true });
});

describe("approval rules", () => {
  it("stores a match in fake HOME and auto-resolves later asks", () => {
    alwaysAllow(BOT, "Bash", "git status");
    expect(loadRules(BOT)).toEqual([
      expect.objectContaining({ tool: "Bash", pattern: "git status", action: "allow" }),
    ]);
    expect(matchRule(BOT, "Bash", "git status")?.action).toBe("allow");
    expect(resolveOpenedRequest(BOT, "Bash", "git status")).toEqual({ behavior: "allow", source: "rule" });
    expect(resolveOpenedRequest(BOT, "Bash", "git push")).toBeNull();
    expect(resolveOpenedRequest(BOT, "Edit", "git status")).toBeNull();
  });

  it("Always allow writes a rule; deny rules auto-deny", () => {
    const written = alwaysAllow(BOT, "shell", "ls -la /tmp");
    expect(written.action).toBe("allow");
    expect(loadRules(BOT)).toHaveLength(1);

    addRule(BOT, { tool: "shell", pattern: "rm -rf *", action: "deny" });
    expect(resolveOpenedRequest(BOT, "shell", "rm -rf scratch")?.behavior).toBe("deny");
  });

  it("does not store raw keys in patterns", () => {
    const pattern = argumentPattern('curl -H "Authorization: Bearer sk-live-supersecret" https://api');
    expect(pattern).not.toContain("sk-live-supersecret");
    expect(pattern).toContain("[redacted]");
    alwaysAllow(BOT, "Bash", "XAI_API_KEY=xai-abc123restofkey /usr/bin/env");
    const stored = loadRules(BOT)[0]?.pattern ?? "";
    expect(stored).not.toMatch(/xai-abc123/i);
    expect(JSON.stringify(loadRules(BOT))).not.toContain("xai-abc123restofkey");
    expect(redactSecrets("token=ghp-not-a-real-token")).toContain("[redacted]");
  });

  it("glob * matches any args for that tool", () => {
    addRule(BOT, { tool: "Read", pattern: "*", action: "allow" });
    expect(resolveOpenedRequest(BOT, "Read", "src/index.ts")?.source).toBe("rule");
  });
});
