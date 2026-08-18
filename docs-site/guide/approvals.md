# Approvals & permissions

Every tool call a bot makes flows through the permission broker before executing.

## Per-bot rules

Each bot carries `requireApproval` and `alwaysAllow` lists you edit in its settings. Allow-once and always-allow choices on approval cards update these rules in place. Always-allow is stored per bot and per tool — never as a workspace-wide rule and never as a wildcard matcher.

## Hard categories

Some actions always produce an approval card regardless of rules: revealing or using secrets, destructive operations, and external communications. Credential and sign-in asks are additionally redirected to the bot's computer screen so passwords and codes never appear in chat.

## Asks

Bots can raise structured asks mid-turn: a choice card (`ask_choice`), a secret request (`ask_secret`, which stores the value sealed and out of the transcript), or an app-connection card (`connect_app`). The turn waits for your answer and resumes.

## Unattended mode

Routines and background-harness runs execute unattended: anything that would raise an approval card instead parks the turn in **Needs input** and notifies you, so unattended never means unbounded.
