# SaaS catalog client boundary

Decision: the first authenticated SaaS surface is composed through
`SessionBoundary` as ephemeral protected content. It has its own bounded
transport and reducer and never mounts the desktop store or SSE shell.

The catalog requests only `GET /api/bots?messages=0`, validates exact response
keys, projects only display fields into memory, and is unmounted whenever the
session boundary leaves `authenticated`. A sign-out cancellation therefore
starts a fresh load under the still-confirmed session instead of restoring a
cross-session cache. This is intentionally reversible; no general SaaS data
layer, persistence, router, or tenant selector is introduced.
