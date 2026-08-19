# ADR 0003: Tenant-scoped bot ownership boundary

Status: Accepted for DHV-18

## Context

DHV-17 introduced durable internal UUID users and sessions, but bot data and
the desktop HTTP API remained intentionally unscoped. Existing local profiles
can contain bots created without an identity, and no product decision has been
made about claiming that data for a future SaaS user.

## Decision

- Add nullable `bots.owner_id` as a foreign key to the stable internal
  `users.id`. Preserve existing bots with `owner_id = NULL`; never infer an
  owner from the first authenticated user.
- Index owner/newest and owner/thread access paths.
- Keep the current unscoped repository methods for desktop compatibility, but
  label them explicitly as unsafe for tenant authorization.
- Expose tenant operations through an owner-bound repository object. Validate
  the owner UUID at the boundary and rely on the database foreign key plus the
  existing transaction to reject nonexistent owners without orphan threads.
- Do not integrate this seam into routes until the approved workflow has
  propagated ownership through every related repository and workspace lookup.

## Consequences and next seam

Tenant bot list, lookup, count, insert, and update are isolated now. Related
messages, routines, memory, computer bindings, deletion, and route/service
authorization are not yet tenant-safe and must not be presented as such.

This additive design keeps desktop data intact and leaves account-claim policy
reversible. Rebuilding bot/thread primary keys as tenant-composite keys was
rejected for this slice: IDs are generated globally, the migration would be
substantially more invasive, and no validated workflow currently requires the
same bot or thread ID to exist under multiple owners.
