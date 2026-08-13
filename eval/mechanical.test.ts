import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { SECRET_NAMES } from "./secrets.mjs";
import { failMechanical, mergeFlowMechanical, mcpScenarioLine, summaryMarkdown } from "./mechanical.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const completedBeforeThrow = {
  serverUp: true,
  uiReachable: true,
  onboardingCompleted: true,
  botsCreated: [],
  grokSkipped: true,
  mcpSkipped: false,
  allowClicked: false,
  allowShown: false,
  streamObserved: {},
};

describe("mechanical report after a mid-flow throw", () => {
  it("does not claim onboarding failed if it completed", () => {
    const missing = failMechanical(completedBeforeThrow, []);
    expect(missing).not.toContain("UI reachable");
    expect(missing).not.toContain("onboarding completed");
    expect(missing).not.toContain("server up");
    expect(missing).toContain("bots created (Support / Ops / Research)");
  });

  it("keeps completed flags when merging the flow error payload", () => {
    const mechanical = {
      serverUp: true,
      uiReachable: false,
      onboardingCompleted: false,
      botsCreated: [],
      grokSkipped: true,
      mcpSkipped: false,
      allowClicked: false,
      allowShown: false,
      streamObserved: {},
    };
    mergeFlowMechanical(mechanical, {
      uiReachable: true,
      onboardingCompleted: true,
      mcpSkipped: false,
    });
    const missing = failMechanical(mechanical, []);
    expect(mechanical.uiReachable).toBe(true);
    expect(mechanical.onboardingCompleted).toBe(true);
    expect(missing).not.toContain("UI reachable");
    expect(missing).not.toContain("onboarding completed");
  });

  it("does not report a missing Codex secret when CODEX_AUTH_JSON is configured", () => {
    const found = { claude: true, codex: true, grok: false, ready: true };
    const line = mcpScenarioLine(found, completedBeforeThrow);
    expect(SECRET_NAMES.codex).toBe("CODEX_AUTH_JSON");
    expect(line).not.toMatch(/no Codex secret|no CODEX_AUTH_JSON/i);
    expect(line).toContain("ran");
    const md = summaryMarkdown(found, completedBeforeThrow, { skipped: true, reason: "eval did not reach judge" }, [
      "bots created (Support / Ops / Research)",
    ]);
    expect(md).toContain("codex (CODEX_AUTH_JSON): configured");
    expect(md).toContain("onboarding: yes");
    expect(md).toContain("UI reachable: yes");
    expect(md).not.toContain("skipped (no Codex secret)");
    expect(md).not.toContain(`skipped (no ${SECRET_NAMES.codex})`);
  });
});

describe("MCP on-request uses the eval gate secret", () => {
  it("wires includeCodexMcp to found.codex / CODEX_AUTH_JSON", () => {
    const run = readFileSync(join(ROOT, "eval/run.mjs"), "utf8");
    const flow = readFileSync(join(ROOT, "eval/flow.mjs"), "utf8");
    expect(run).toContain("includeCodexMcp: found.codex");
    expect(run).toContain("mcpSkipped: !found.codex");
    expect(flow).toContain("if (includeCodexMcp) roster.push(MCP_BOT)");
    expect(flow).toContain("SECRET_NAMES.codex");
    expect(flow).toContain("mcpSkipped: !includeCodexMcp");
  });
});
