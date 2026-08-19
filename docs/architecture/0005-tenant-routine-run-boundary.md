# ADR 0005: Tenant-scoped routine and run-ledger boundary

Status: Accepted for DHV-21

## Context

Bots already have nullable ownership, but routine configuration and its run
ledger were reachable only through the legacy process-wide repository. A
caller with an exact routine ID, run sequence, or idempotency key could not use
that interface as a tenant authorization boundary. Existing desktop profiles
also contain deliberately unowned bots and routines whose account-claim policy
has not been decided.

## Decision

- Derive routine ownership on every operation through
  `routines.bot_id -> bots.owner_id`. Do not duplicate mutable ownership on
  routine or run rows.
- Expose tenant CRUD and run operations only through
  `routines.forOwner(userId)`. The returned type contains no global recovery
  or process-wide query capability, and unowned or foreign identifiers behave
  as absent.
- Authorize insertion against an existing bot owned by the same user inside
  the insertion transaction. Keep routine identifiers globally unique; an ID
  or idempotency-key collision fails without creating routine or run rows.
- Authorize run claims against both the stored routine-to-bot relationship and
  the bot owner. Authorize finish, lease renewal, and history through the run's
  routine rather than trusting the denormalized `routine_runs.bot_id` value.
- Keep unscoped repository methods for local desktop compatibility. Mark them
  unsafe for tenant authorization, and expose the run-ledger subset as
  `internalScheduler` for trusted process-wide ticking and crash recovery.
  Later SaaS route/service wiring must use `forOwner`; it must never inject or
  expose the global scheduler seam.
- Preserve explicit transactional run cleanup on routine deletion. No schema
  migration is needed for this slice.

## Consequences and next seam

Routine CRUD, run creation/settlement, lease renewal, and history now have a
repository-level tenant boundary without claiming legacy desktop data.
Scheduler idempotency, leases, pruning, missed-run policy, listener cursors,
and boot recovery keep their process-wide semantics.

The current desktop routine service and routes remain intentionally unscoped.
They are not SaaS authorization evidence. A later approved route/service slice
must construct an owner-bound service for each authenticated request and keep
global ticking/recovery in trusted startup infrastructure.

Adding `owner_id` to routines or run rows was rejected because it would create
mutable duplicated authority and migration/backfill policy without a validated
need. Composite tenant keys were also rejected because identifiers are already
globally generated and no approved workflow requires per-tenant duplicates.
