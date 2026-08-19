# ADR 0009: Tenant bot public handles

Status: Accepted for DHV-48

## Context

The SaaS catalog deliberately withholds internal bot and thread UUIDs, while
display names are mutable and non-unique. Future per-bot workflows therefore
need a stable client-visible identifier that does not weaken the existing
owner authorization boundary or couple public URLs to internal relationships.

## Decision

- Generate an unpadded 22-character base64url handle from 16 cryptographically
  random bytes (128 bits) inside the owned repository insertion path. Request
  DTOs cannot provide or influence it.
- Store the current assignment in nullable `bots.public_handle`; legacy
  `owner_id = NULL` desktop bots remain `NULL`.
- Reserve every issued handle in `public_bot_handles`, a retained ledger whose
  row outlives bot deletion. Database constraints and triggers enforce format,
  uniqueness, matching bot assignment, required owned assignments, and
  immutability.
- Backfill only existing owned bots in the migration transaction. Bounded
  collision retries avoid partial state; exhaustion rolls back the migration
  so reopening can retry safely.
- Resolve handles only from the existing owner-bound repository/service
  facades. Malformed, unknown, foreign-owner, and legacy handles all return the
  same absent result. A handle remains an identifier, never authorization.
- Add only the handle to the narrow SaaS catalog/create projection. Keep the
  desktop-global bot representation unchanged.

## Consequences and alternatives

The ledger adds one small retained row per issued SaaS bot and intentionally
prevents reuse after deletion. Future detail or turn routes can use the
owner-bound lookup without exposing UUIDs, but those routes remain outside this
decision.

Encoding internal UUIDs was rejected because it leaks relationships and makes
the public contract depend on internal key choices. Using display-name slugs
was rejected because rename and duplicate-name behavior cannot provide stable,
unambiguous routing. A single unique bot column without the retained ledger was
also rejected because deleting a bot would permit accidental handle reuse.
