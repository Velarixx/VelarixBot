// Mechanical invariants + summary for the Playwright eval.
// Pure helpers so tests can assert report truthfulness without launching the app.

import { formatPresence, SECRET_NAMES } from "./secrets.mjs";
import { mcpMechanicalFail } from "./mcp.mjs";

export function failMechanical(mechanical, transcripts = []) {
  const missing = [];
  if (!mechanical.serverUp) missing.push("server up");
  if (!mechanical.uiReachable) missing.push("UI reachable");
  if (!mechanical.onboardingCompleted) missing.push("onboarding completed");
  const created = mechanical.botsCreated ?? [];
  if (!["Support", "Ops", "Research"].every((name) => created.includes(name))) {
    missing.push("bots created (Support / Ops / Research)");
  }
  const streams = mechanical.streamObserved ?? {};
  if (!Object.values(streams).some(Boolean)) missing.push("stream observed");
  if (mechanical.mcpSkipped === false) {
    if (!created.includes("Roster")) missing.push("Codex MCP bot created (Roster)");
    const mcpTurn = transcripts.find((t) => t.bot === "Roster");
    missing.push(...mcpMechanicalFail(mcpTurn));
  }
  return missing;
}

/** Skip/run line must follow the same CODEX_AUTH_JSON gate as --gate, not a stale default. */
export function mcpScenarioLine(found, mechanical) {
  if (!found.codex) return `skipped (no ${SECRET_NAMES.codex})`;
  if (mechanical.mcpSkipped) return "skipped (TIER_B_MAX_TURNS cap)";
  return "ran (list_bots exactly once + Allow)";
}

export function mergeFlowMechanical(target, partial) {
  if (!partial || typeof partial !== "object") return target;
  Object.assign(target, partial);
  return target;
}

export function summaryMarkdown(found, mechanical, judge, missing) {
  const rows = ["Support", "Ops", "Research"].map((name) => {
    const stream = mechanical.streamObserved?.[name] ? "yes" : "no";
    const score = judge.scores?.find((s) => s.bot === name);
    const cell = (key) => (score?.[key]?.score ?? score?.error ?? "—");
    return `| ${name} | ${stream} | ${cell("inPersona")} | ${cell("addressedRequest")} | ${cell("noFabricatedCapabilities")} |`;
  });
  return [
    "## Playwright eval",
    "",
    "### Secrets (presence only)",
    "```",
    formatPresence(found),
    "```",
    "",
    "### Mechanical",
    `- server up: ${mechanical.serverUp ? "yes" : "no"}`,
    `- UI reachable: ${mechanical.uiReachable ? "yes" : "no"}`,
    `- onboarding: ${mechanical.onboardingCompleted ? "yes" : "no"}`,
    `- bots created: ${(mechanical.botsCreated ?? []).join(", ") || "none"}`,
    `- Grok scenario: ${mechanical.grokSkipped ? "skipped (xAI not required)" : "ran (optional secret present)"}`,
    `- Hermes scenario: ${mechanical.hermesSkipped ? "skipped (Hermes not required)" : "ran (optional secret present)"}`,
    `- Codex MCP on-request: ${mcpScenarioLine(found, mechanical)}`,
    `- Allow clicked: ${mechanical.allowClicked ? "yes" : mechanical.allowShown ? "shown, click failed" : "not shown (not a fail)"}`,
    `- hard-fail: ${missing.length ? missing.join("; ") : "none"}`,
    "",
    "### Judge (report-only — never fails the job)",
    judge.skipped ? `_skipped: ${judge.reason}_` : `_model: ${judge.model}_`,
    "",
    "| Bot | Stream | In persona | Addressed | No fabrications |",
    "|-----|--------|------------|-----------|-----------------|",
    ...rows,
    "",
  ].join("\n");
}
