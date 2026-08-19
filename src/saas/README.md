# SaaS catalog client boundary

Decision: the first authenticated SaaS surface is composed through
`SessionBoundary` as ephemeral protected content. It has its own bounded
transport and reducer and never mounts the desktop store or SSE shell.

The catalog requests only `GET /api/bots?messages=0`, validates exact response
keys, projects only display fields into memory, and is unmounted whenever the
session boundary leaves `authenticated`. Its sole write is a dedicated
default-only `POST /api/bots` with body `{}`. A bounded, valid 201 response is
discarded and triggers a fresh bounded catalog GET; only that GET can replace
the display projection in component state.

Creation uses generic client-only progress, success, quota, and failure state.
It rejects duplicate submissions through the POST and refetch, aborts on
unmount, and retries only the GET if a confirmed create was followed by a
failed refresh. A sign-out cancellation therefore starts a fresh load under
the still-confirmed session instead of restoring a cross-session cache. This
is intentionally reversible; no desktop store/modal, general SaaS data layer,
persistence, router, or tenant selector is introduced. See
`DHV-43-UX-EVIDENCE.md` for the pre-implementation audit and decision options.
