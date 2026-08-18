# Glossary

**ACP** — Agent Client Protocol; the JSON-RPC protocol the Grok and Gemini CLIs speak, and the transport for those engines' drivers.

**Box** — the cloud desktop provider bots can be bound to; a persistent Linux desktop with Chrome that you can watch live.

**Broker** — the permission layer every tool call passes through; per-bot allow/require rules plus hard categories that always ask.

**Coalescing** — merging repeated triggers (for example routine ticks missed during sleep) into a single run on resume.

**CUA driver** — the bundled computer-use driver that lets Claude/Codex bots control the local machine.

**Harness** — the local server (`127.0.0.1:8799`) that owns the store, spawns engine sessions, runs routines, and streams SSE events. Runs inside the app or as a background service.

**Instance** — a configured engine (built-in CLI or API provider) that bots can route turns to; carries a model catalog and an availability snapshot.

**Teach session** — a recorded demonstration that gets distilled into a reusable taught skill.

**Workspace** — the whole local installation: all bots, threads, routines, skills, and shared notes under `~/.velarixbot`.
