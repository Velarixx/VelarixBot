# ADR 0001: Explicit UI connection state

- Status: Accepted
- Date: 2026-08-18
- Scope: DHV-5 connection-loss experience

## Context

Velarixbot hydrates a snapshot and then follows server events through a resumable
stream. When that stream is unavailable, an already-hydrated workspace can still
look fully usable. The composer previously cleared its local draft before the
failed request became visible, which made a recoverable outage feel like data
loss.

## Decision

Keep the existing resumable stream and API architecture. Track whether the stream
has ever connected during the current session, show a persistent app-level
connecting/reconnecting notice, and prevent the composer from dispatching while
offline. The composer remains editable so the local draft survives until the
connection returns.

This state is session-local and contains no tenant or message data. The server
remains authoritative; the client does not create an offline mutation queue.

## Consequences

- Users can distinguish startup from a dropped connection and understand that
  sending is temporarily unavailable.
- Draft text and attachments remain local instead of being cleared by a request
  that cannot succeed.
- Existing event replay and recovery behavior is unchanged and reversible.
- Other mutation surfaces are not yet disabled while offline. A centralized
  offline mutation queue was considered but rejected for now because it adds
  ordering, approval, audit, and conflict semantics without evidence that the
  product needs them.
