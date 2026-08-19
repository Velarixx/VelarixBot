# ADR 0004: Tenant-scoped thread and message boundary

Status: Accepted for DHV-19

## Context

DHV-18 owner-bound bot lookups, but a bot's thread and messages were still
reachable only through the legacy unscoped repository. Tenant route exposure
would therefore permit identifier-based cross-user access, including screenshot
blob reads and destructive thread cleanup. Group ownership remains undecided.

## Decision

- Add nullable `threads.owner_id` referencing the stable internal `users.id`.
  Backfill only threads joined to bots that already have an owner; leave
  desktop, group, and orphan threads unowned.
- Create tenant bots and their threads in one transaction with identical
  owners. Preserve explicitly unscoped desktop insertion.
- Expose tenant message operations only through `messages.forOwner(userId)`.
  Every list, page, find, image, append, patch, delete, and count operation
  first requires a thread owned by that user. The bound interface exposes no
  unscoped row deletion or blob-GC primitive.
- Tenant append never creates or claims a thread. Authorization and insertion
  share a database transaction, and authorization occurs before screenshot
  bytes can be written.
- Authorize destructive thread cleanup inside its transaction and garbage
  collect blobs only after commit. Global message references and bot-avatar
  references continue to protect shared content.
- Keep the legacy unscoped repository for the local desktop runtime. Do not
  wire HTTP routes or services until group/shared-thread authorization has its
  own approved slice.

## Consequences and next seam

Owned bot transcripts now have a repository-level tenant boundary without
claiming legacy data or changing desktop behavior. The nullable column keeps
the migration additive and the account-claim decision reversible.

Groups, routines, memory, computer bindings, bot cascade deletion, and route
authorization are not made tenant-safe by this decision. A later group
ownership slice must define shared-thread membership before SaaS routes can
treat every thread as authorizable.

Rebuilding thread/message keys as tenant-composite keys was rejected for this
slice: identifiers are globally generated, the migration would be invasive,
and no validated workflow requires duplicate thread or message identifiers
across owners.
