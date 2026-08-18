# Watching bots work

Each bot's header shows its live state: **Idle**, **Running**, **Blocked**, **Needs input**, or **Paused**. The mascot face reacts to what the bot is doing — it looks around while thinking, widens its eyes when it needs you, and settles when done.

The sidebar rolls the same states up per bot with unread badges, so a glance shows which teammates are working, stuck, or waiting on you. Token usage for the current thread appears next to the model picker in the header.

When a bot is blocked, the banner states a human reason — `` `grok` CLI not found ``, or "This engine is not signed in" — and the thread receives an actionable card (switch model, install, or sign in) rather than a raw error code. Turns that stall in **Needs input** or **Blocked** for a long time trigger a proactive nudge so silent stalls surface instead of waiting forever.

Everything the bot does on a computer is visible: the computer panel streams the desktop it drives, and screenshots taken during turns are stored as content-addressed blobs you can reopen from the transcript.
