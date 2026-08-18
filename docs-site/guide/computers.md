# Computers

A bot's computer binding is one of **off**, **local**, or a **Box** cloud desktop. Bindings are canonicalized and validated: pointing a bot at a removed provider is an explicit error, never a silent failover.

## Local

The bundled CUA driver lets Claude and Codex bots control this machine — mouse, keyboard, and screen. macOS will prompt for Accessibility and Screen Recording permissions the first time; approve only what you intend to use. Windows is supported through the same bundled driver.

## Box (cloud desktop)

With a Box token configured, a bot can lease a persistent cloud Linux desktop with Chrome. You watch it live in the computer panel while the bot drives. Leases are tracked per bot and cleaned up via the computer cleanup endpoint when released.

## Shared computer

The App Settings toggle **Shared computer** switches all bots to a single Box desktop and a single Chrome profile, Grok Bot-style: every bot can see the others' files and logins on that machine. A per-person computer name prefix keeps desktops distinct when several people share one Box account. Treat the shared desktop as a trust boundary you opted into — sign-ins performed there are visible to every bot bound to it.

## Sign-ins on a computer

When a task requires logging in to a website, the bot hands off: "Complete the sign-in on this computer. Passwords and codes stay on that screen — never type them in chat." Credentials never transit the thread.
