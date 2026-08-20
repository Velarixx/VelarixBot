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
  It returns only an initial encoded image and an asynchronous image-frame
  stream. `connectScreen(botId)` and every desktop provider remain unchanged.
- Resolve the grant and capture the owner-scoped current binding server-side in
  one synchronous event-loop turn. Select exactly one viewer-capable provider
  by the bound provider kind. The route cannot accept an owner, provider,
  machine, bot, workspace, scope, URL, or credential parameter.
- Relay only size- and signature-checked PNG/JPEG frames through a fixed
  `multipart/x-mixed-replace` response with no-store, same-origin framing,
  no-referrer, nosniff, and restrictive content-security headers. Provider
  headers, URLs, status, identifiers, errors, and text never cross the route.
- Bound provider startup to two seconds. Collapse every invalid capability to
  one 404 response and every provider startup failure to one redacted 503.
- Track live views only by an in-memory SHA-256 token digest. Grant revocation
  aborts all matching streams; grant expiry and client disconnect also abort
  the provider signal. No digest or provider detail is logged.

## Consequences and next rule

This is a view-only byte broker, not a general reverse proxy. It introduces no
VM, SSH, VNC/noVNC, workspace, computer, or bot-management surface and cannot
forward arbitrary provider HTTP. The deterministic fake provider proves the
composition without external I/O.

A production provider may implement `openViewer` only after independent review
of its server-side frame transport, cancellation, bounds, and credential
handling. The alternative of proxying or rewriting a minted noVNC/join URL was
rejected because URLs, redirects, assets, WebSockets, response headers, and
upstream errors create multiple credential-disclosure paths. The alternative
of returning a URL for an iframe was rejected because it would move the
provider trust boundary into browser JavaScript and the DOM.
