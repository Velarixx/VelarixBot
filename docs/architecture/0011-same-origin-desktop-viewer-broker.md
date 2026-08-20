# ADR 0011: Same-origin scoped desktop viewer broker

Status: Proposed for DHV-99 independent security and browser review

## Context

The desktop `ComputerProvider` contract opens provider-minted join URLs keyed
by bot ID. That contract is compatible with the trusted Electron application,
but a SaaS browser must not receive a join URL, provider token, machine or
provider identity, management credential, or provider error. The existing
HttpOnly `desktop:view` grant already proves owner, current workspace binding,
binding generation, exact scope, revocation, and expiry, but it intentionally
returns no workspace identity to a route.

## Decision

- Keep `/api/desktop-access` and its Secure, HttpOnly, SameSite=Strict,
  path-scoped cookie unchanged. Add only `GET /api/desktop-access/view` under
  that cookie path and the existing SaaS session boundary.
- Add an optional `ComputerProvider.openViewer(machineId, { signal })` seam.
  It returns only exact-size RGBA pixels (width, height, and four bytes per
  pixel) plus an asynchronous pixel-frame stream. `connectScreen(botId)` and
  every production desktop provider remain unchanged.
- Resolve the grant and capture the owner-scoped current binding server-side in
  one synchronous event-loop turn. Select exactly one viewer-capable provider
  by the bound provider kind. The route cannot accept an owner, provider,
  machine, bot, workspace, scope, URL, or credential parameter.
- Accept only 1..1920 by 1..1080 frames whose byte count is exactly
  `width * height * 4` and at most 8 MiB. The server constructs deterministic
  metadata-free PNG files and relays them through a fixed
  `multipart/x-mixed-replace` response with no-store, same-origin framing,
  no-referrer, nosniff, and restrictive content-security headers. A duplicate
  canonical first frame primes the next multipart boundary so Chromium paints
  a quiet desktop immediately. Provider headers, URLs, status, identifiers,
  encoded metadata, trailing data, errors, and text never cross the route.
- Bound provider startup to two seconds. Collapse every invalid capability to
  one 404 response and every provider startup failure to one redacted 503.
- Track same-process live views only by an in-memory SHA-256 token digest for
  immediate local revocation, and independently re-resolve the durable exact
  owner/token/`desktop:view`/current binding every 250 ms. Re-resolve again
  after every awaited provider frame and after canonical encoding, immediately
  before bytes are written. A revoke, expiry, foreign/stale/ABA binding, read
  failure, client disconnect, or local close aborts the provider and response.
  The operational disconnect target is under one second including scheduler
  and HTTP jitter.

## Cost, latency, and audit consequences

Each active viewer adds at most four indexed SQLite authorization reads per
second while idle, plus two reads per provider frame. PNG encoding adds one
bounded RGBA copy, DEFLATE operation, and final authorization read per frame;
the 1920x1080/8 MiB caps bound memory and event-loop work. Backpressure remains
propagated before the next provider frame is requested.

Grant issue, user-visible resolve, and revoke retain their existing metadata-
only audit events. Monitor and per-frame authorization reads deliberately do
not append audit rows: doing so would amplify a long-lived viewer into an
unbounded audit stream. Viewer-open/provider-timeout/disconnect lifecycle
events remain unrecorded in this increment because the current audit schema has
no approved event contract for them; adding that contract requires a separate
security/retention decision. No token digest or provider detail is logged.

## Consequences and next rule

This is a view-only byte broker, not a general reverse proxy. It introduces no
VM, SSH, VNC/noVNC, workspace, computer, or bot-management surface and cannot
forward arbitrary provider HTTP. The deterministic fake provider proves the
composition without external I/O.

A production provider may implement `openViewer` only after independent review
of its server-side frame transport, cancellation, bounds, and credential
handling. A decoder/re-encoder dependency was deferred because no production
viewer implementation currently requires encoded input and adding a parser to
this security boundary would be a new irreversible dependency decision. The
alternative of proxying or rewriting a minted noVNC/join URL was rejected
because URLs, redirects, assets, WebSockets, response headers, and upstream
errors create multiple credential-disclosure paths. The alternative of
returning a URL for an iframe was rejected because it would move the provider
trust boundary into browser JavaScript and the DOM.
