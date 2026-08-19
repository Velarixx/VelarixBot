# ADR 0006: Mode-aware authenticated request principal boundary

Status: Proposed for DHV-24 independent review

## Context

The desktop application already protects its loopback HTTP API with a
per-launch bearer, Host validation, and a loopback browser-Origin rule. Durable
internal UUID users and server-side sessions now exist, but accepting a session
on the existing business routes would falsely claim complete tenant routing.
The internal COMMS credential is a third, separate trust boundary.

## Decision

- `VELARIX_AUTH_MODE` is an explicit two-value mode. Missing or `desktop`
  preserves the current desktop boundary; `saas` opts into session-cookie
  authentication. Any other value aborts startup.
- SaaS mode requires `VELARIX_APP_ORIGIN` to be one exact serialized HTTPS
  origin. Every cookie-authenticated `POST`, `PUT`, `PATCH`, or `DELETE`
  requires an exactly matching `Origin`; missing or variant origins fail before
  route dispatch. The desktop loopback-Origin allowlist is not reused.
- The `velarix_session` cookie is resolved only through `IdentitySessions`.
  Missing, malformed, ambiguous, unknown, expired, and revoked credentials all
  return the same minimal 401 response. Desktop bearer and COMMS tokens are
  never fallback credentials.
- Authentication adds only `{ kind: "internal-user", user: { id: UUID } }` to
  `RouteCtx`. SaaS mode dispatches only `/api/session` (plus the existing health
  probe); the session response allowlists only that UUID.
- The server listener remains `127.0.0.1`. This decision adds no OAuth callback,
  proxy trust, public listener, deployment, or business-route exposure.

## Consequences and next integration rule

Future SaaS business routes must be composed separately from the desktop route
set and must consume owner-bound services using `principal.user.id`. A route
must not accept a client-supplied user/owner ID or use the unscoped desktop
services. GitHub OAuth authorization and callback exchange is a follow-up: it
must establish a session from verified provider output and must not be
simulated with trusted client identity fields.

The principal intentionally omits provider metadata so later account-linking or
identity-provider changes remain reversible. The alternative of making the
existing route set session-aware was rejected because several downstream
resources (including computers and workspaces) are not yet proven tenant-safe.
