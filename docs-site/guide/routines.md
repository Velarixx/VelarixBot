# Routines

A routine is a schedule plus a prompt for one bot. Create them in the Routines panel or let a bot propose one after you accept a workflow suggestion.

Each routine has a missed-run policy — skip, run once on resume, or catch up — that decides what happens when the machine was asleep or the harness was down at fire time. Repeated misses coalesce rather than stampede.

Routines run under the harness. With the background service installed (see [Background harness](/guide/background-harness)), they fire with the app window closed; without it, they run while VelarixBot is open. Routine runs appear in the bot's thread like any other turn, subject to the same permission broker in unattended mode.

A taught skill can be attached to a routine, so "do the Monday report the way I showed you" is one row: schedule + skill + bot.
