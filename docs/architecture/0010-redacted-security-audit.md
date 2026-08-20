# ADR 0010: Redacted security-decision audit stream

Status: Accepted for DHV-82

## Context

The SaaS OAuth, session, tenant catalog/quota, and server-only desktop grant
boundaries make durable security decisions, but the general runtime event log
was not a safe audit interface. Its payloads are open-ended, its streams use
product identifiers, and write failures are intentionally best-effort for UI
continuity.

## Decision

- Reuse the SQLite event log's durable per-stream sequencer through a dedicated
  security-audit service rather than add a second logging system.
- Store only a versioned allowlist of action, allow/deny decision, reason, and
  server time. Tenant IDs are represented only by a SHA-256-derived stream key;
  tokens, cookies, OAuth material, provider/workspace values, paths, errors,
  stacks, and arbitrary metadata cannot enter the service API.
- Expose only owner-bound audit reads, projected back onto the allowlisted
  fields. Anonymous OAuth failures use an internal system stream that is not
  reachable through tenant reads.
- Make security audit rows immutable with database triggers. Wrap state-changing
  allows and their append in one SQLite transaction, so an audit failure rolls
  back OAuth-start state, session, catalog, and grant mutations. Successful and
  denied session resolution are both recorded; read/deny paths surface audit
  failure as a closed request.
- Guard both ordinary UPDATE/DELETE and every `INSERT OR REPLACE` conflict key.
  SQLite does not recursively fire the replacement DELETE trigger by default,
  so relying on that trigger alone would permit audit-row replacement. A narrow
  insert guard was chosen instead of changing recursive-trigger behavior for
  every existing application trigger.
- Wrap existing identity and desktop-grant capabilities in composition. Their
  underlying security modules remain unchanged and independently testable.

## Consequences

This keeps the architecture reversible: a later sink can implement the same
narrow recorder without changing decision points. The event-log table remains
shared, but security rows have stronger immutability and redaction guarantees.
The alternative of logging request/provider objects was rejected because a
denylist cannot make evolving credential-bearing inputs safe. A separate audit
database was deferred until retention, compliance, or scale evidence requires
independent storage.
