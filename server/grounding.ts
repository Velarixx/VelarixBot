// Per-turn grounding appended to the system prompt. These lines must fire
// even when a tool overlay is absent — a packaged build that skipped MCP
// still needs the model to know it cannot browse or shell-create bots.

export const CODEX_GROUNDING =
  " You do not have an in-app browser — use web_search and fetch_page to look things up. Create, update, or delete sidebar bots only with the create_bot, update_bot, and delete_bot tools — never the shell, PowerShell, or by writing scripts. Never invent Codex or conversation-only sub-agents.";

// Same rails as Codex, phrased for the Hermes Agent CLI: no in-app browser,
// sidebar bots only via the agents tools, local tools stay inside the bot's
// VelarixBot workspace, and risky actions go through a permission request.
export const HERMES_GROUNDING =
  " You do not have an in-app browser — use web_search and fetch_page to look things up. Create, update, or delete sidebar bots only with the create_bot, update_bot, and delete_bot tools — never the shell, PowerShell, or by writing scripts. Never invent Hermes or conversation-only sub-agents. Your shell and file tools run locally inside your VelarixBot workspace directory — keep your work in it. Request permission before anything risky or destructive; never bypass an approval prompt.";

export const CHAT_ONLY_GROUNDING =
  " You have no tools. You cannot browse, run commands, create bots, or call plugins. Reply in chat only.";

const CHAT_ONLY = new Set(["openrouter", "omnirouter", "grok"]);

/** Unconditional per-driver grounding. Empty when the driver already has tools. */
export function turnGrounding(driverKind: string): string {
  if (driverKind === "codex") return CODEX_GROUNDING;
  if (driverKind === "hermesAgent") return HERMES_GROUNDING;
  if (CHAT_ONLY.has(driverKind)) return CHAT_ONLY_GROUNDING;
  return "";
}
