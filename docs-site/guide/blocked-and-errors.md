# Blocked states & errors

A blocked bot always shows a human reason and, where possible, an actionable card. Machine codes live in a separate `stateCode` field for the API; the banner never shows raw internals.

## Engine not installed

`stateCode: engine_unavailable` — the banner reads like `` `grok` CLI not found `` and the thread receives a card offering to switch model or explaining what to install. Sending a message to a bot whose engine is missing short-circuits to this card; no session is spawned to fail.

## Engine not signed in

`stateCode: auth_required` — the engine CLI exists but its login is stale or absent. The card explains where to sign in. The Codex refresh-token-reused case ("your refresh token was already used") maps here: quit stray sessions, run the Codex login flow in a terminal, and retry. Never type provider passwords into chat; sign-ins happen in the CLI or on the bot's computer screen.

## Budget pause *(roadmap)*

`PAUSED_BUDGET` will render with its own card once budget policies land — see [Roadmap](/reference/roadmap).

## Stalls

Turns waiting in **Needs input** or **Blocked** beyond the stall window trigger a proactive nudge notification so nothing waits silently.
