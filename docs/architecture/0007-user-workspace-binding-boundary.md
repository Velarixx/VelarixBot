# ADR 0007: User-scoped computer/workspace binding boundary

Status: Accepted for DHV-26

## Context

The desktop product persists a provider machine cache in
`computer_bindings`, keyed by bot ID. A SaaS user instead needs one isolated
remote computer/workspace shared by only that user's bots. Inferring a user
from legacy bots would silently claim desktop data, while reinterpreting the
existing table would mix incompatible authorization boundaries.

## Decision

- Add a separate `user_workspace_bindings` table keyed by the internal
  `users.id` UUID. SQLite enforces one row per user, one owner per
  provider/machine pair, and a restrictive user foreign key.
- Expose access only through `userWorkspaceBindings.forOwner(userId)`. Reads,
  atomic record/update, and compare-and-delete operations always include the
  bound owner. Foreign and unowned identifiers are never returned or mutated.
- Keep `computer_bindings` and its bot-deletion cascade unchanged. Do not
  backfill, infer, or claim user ownership for any legacy desktop row.
- Require explicit binding deletion before deleting a user. This prevents a
  machine identity from becoming silently available for reassignment while
  provider lifecycle behavior remains unimplemented.

## Consequences and exact next rule

The two seams are temporarily intentional: the bot-keyed table supports the
existing desktop workflow, while the user-keyed table is the sole persistence
boundary suitable for authenticated SaaS computer orchestration. This slice
does not provision, call, archive, or expose a provider machine.

The exact next integration rule is: authenticated SaaS computer orchestration
must first resolve the server-side session to the internal principal UUID and
then use only `userWorkspaceBindings.forOwner(resolvedUser.id)`. Provider calls
and routes must never accept, derive from payloads, or forward a client-supplied
owner ID. Independent review is required before adding any such route or
provider integration.

Replacing the desktop table or backfilling it was rejected because no approved
account-claim policy exists. A single polymorphic owner column was also
rejected because it would weaken foreign-key integrity and make the security
boundary harder to audit.
