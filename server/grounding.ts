// Per-turn grounding appended to the system prompt. These lines must fire
// even when a tool overlay is absent — a packaged build that skipped MCP
// still needs the model to know it cannot browse or shell-create bots.

export const CODEX_GROUNDING =
  " You do not have an in-app browser — use web_search and fetch_page to look things up. Create, update, or delete sidebar bots only with the create_bot, update_bot, and delete_bot tools — never the shell, PowerShell, or by writing scripts. Never invent Codex or conversation-only sub-agents.";

export const CHAT_ONLY_GROUNDING =
  " You have no tools. You cannot browse, run commands, create bots, or call plugins. Reply in chat only.";

const CHAT_ONLY = new Set(["openrouter", "omnirouter", "grok"]);

/** Unconditional per-driver grounding. Empty when the driver already has tools. */
export function turnGrounding(driverKind: string): string {
  if (driverKind === "codex") return CODEX_GROUNDING;
  if (CHAT_ONLY.has(driverKind)) return CHAT_ONLY_GROUNDING;
  return "";
}
