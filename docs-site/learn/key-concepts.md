# Key concepts

**Bot.** A named teammate with its own thread, color, mascot face, engine + model selection, memory, permission settings, enabled apps and skills, and computer binding. Created through the create modal (name, role, color, avatar, model) or the API.

**Engine (instance).** The runtime a bot's turns execute on. Built-ins: Claude Code, Codex, Grok CLI, and Gemini CLI (via ACP), plus OpenRouter/OmniRouter API instances. Engines report availability with a human reason (for example `` `grok` CLI not found ``), and unavailable engines are shown dimmed with that reason.

**Turn.** One user message → one engine session run, streamed as events (text chunks, tool calls, plan updates, approvals) into the thread.

**Permission broker.** Every tool call flows through per-bot `requireApproval` / `alwaysAllow` rules. Hard categories — secrets, destructive operations, external communications — always produce an approval card.

**Computer.** A bot can be bound to `off`, `local` (drive this machine via the bundled CUA driver), or a cloud Box desktop. A shared Box mode gives all bots one desktop and one Chrome, Grok Bot-style.

**Routine.** A scheduled prompt for a bot, with missed-run policies. Runs under the harness — including the background service.

**Memory.** Per-bot markdown plus structured rows (preference / fact / workflow) injected as "What you know about this user," reinforced on use and decayed when idle.

**Taught skill.** A recorded demonstration distilled into a reusable markdown skill a bot can run later.
