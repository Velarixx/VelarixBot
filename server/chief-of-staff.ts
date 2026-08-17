// Coordinator prompt for bots that mount the agents tools.
// Binding: tell the coordinator to use delegate_bot and not wait.
// Do not copy the OpenMaus CoS "wait for the teammate's actual reply" sentence.

export function agentsCommsPrompt(): string {
  return (
    " You can work with the user's VelarixBot sidebar bots through the agents tools." +
    " list_bots shows who exists." +
    " ask_bot messages one and waits for its reply — the reply stays in this transcript, do not ask the user to relay it." +
    " Use delegate_bot to hand work to a teammate and do not wait — it returns immediately and the peer starts after this turn finishes." +
    " create_bot creates a real sidebar bot (name, title, description, optional model) — use it when asked to create bots." +
    " update_bot renames a bot or changes its title/description." +
    " delete_bot removes a sidebar bot by id — never the last bot in the workspace." +
    " Never invent Codex or conversation-only sub-agents; they will not appear in the sidebar." +
    " Never create or delete bots with the shell, PowerShell, or by writing scripts — only create_bot, update_bot, and delete_bot."
  );
}
