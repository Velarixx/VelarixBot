# HTTP API

The harness serves a local HTTP API on `http://127.0.0.1:8799`. Every route under `/api/*` except `/api/health` requires a bearer token (see [Security model](/reference/security)). All bodies are JSON.

## Health

`GET /api/health` — unauthenticated liveness probe. Returns `{ app, pid, static, stamp }`; the pid/stamp pair is how the client proves a running server is its own and current.

## Bots

`GET /api/bots` — list bots with messages, state, model selection, and usage.

`POST /api/bots` — create a bot. Body honors `name`, `title`, `description`, `color`, `model`, `computer`. Returns `201 { bot }`.

`GET | PATCH | DELETE /api/bots/:id` — read, update, or remove. PATCH accepts the settable fields (name, title, notifications, modelSelection, computer, color, mascot fields, avatar fields, pinned, requireApproval, alwaysAllow, enabledApps, enabledSkills, threadParticipants, …). Whitespace-only names are rejected. Removing the last bot is refused.

`POST /api/bots/:id/messages` — send a user message and start a turn. Body `{ text, attachments? }`. Returns `{ ok, threadId, messageId }`.

`POST /api/bots/:id/respond` — answer a pending ask/approval card.

`POST /api/bots/:id/interrupt` — stop the current turn.

`GET | PUT /api/bots/:id/memory` — read or write markdown memory; GET also returns structured `rows`.

`POST /api/bots/:id/avatar/generate` — generate portrait candidates via the configured image provider; errors clearly when no provider key is set.

## Engines & config

`GET /api/instances` — engine instances with availability snapshots, reasons, and model catalogs.

`GET | PATCH /api/config` — app-level configuration (secret values are `secret://` references, never plaintext).

## Events

`GET /api/events` — the SSE stream (bot state, messages, wakeups, computer frames). Supports `?lastEventId=` resume. `GET /api/events/snapshot` returns current state for cold starts.

## Routines, skills, teaching

`GET | POST /api/routines`, `PATCH | DELETE /api/routines/:id` — schedules with missed-run policies.

`GET | POST /api/skills`, `GET | PATCH | DELETE /api/skills/:id` — taught skills as markdown.

`POST /api/teach-sessions` and session subroutes — start/stop demonstration recording.

## Connectors & computers

`GET /api/connectors/catalog`, `GET /api/connectors?services=…&botId=…`, `POST /api/connectors/sessions` — Composio app connections per bot.

`POST /api/computer/cleanup` — release leased cloud desktops.

## Internal (bot-to-bot) surface

`/api/internal/*` routes (`ask-bot`, `delegate-bot`, `create-bot`, `update-bot`, `delete-bot`, `agents`, `workspace`, `remember`, `recall`) are the tools bots use on each other, exposed to engine sessions through the harness — same bearer protection, plus broker mediation per calling bot.
