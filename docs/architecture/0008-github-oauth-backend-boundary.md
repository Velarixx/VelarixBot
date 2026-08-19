# ADR 0008: GitHub OAuth backend boundary

Status: accepted for DHV-29 independent review

## Context

The reviewed UUID identity/session foundation and mode-aware request principal
boundary need one server-only GitHub sign-in path. Desktop behavior, internal
COMMS isolation, and the absence of SaaS business routes must remain unchanged.
OAuth browser parameters are replayable unless the server owns a bounded,
one-time transaction, and provider tokens must not cross the adapter boundary.

## Decision

- Enable the OAuth route module only in SaaS composition. The only public entry
  exemptions are exact `GET /api/auth/github/start` and exact
  `GET /api/auth/github/callback` pairs. Desktop does not mount or exempt them.
- Persist SHA-256 digests of 256-bit state and a separate 256-bit transaction
  cookie. Persist the PKCE verifier server-side and consume it with one
  conditional `UPDATE ... RETURNING` before provider exchange or session issue.
  Prune expired rows on new starts and cap stored transactions at 10,000.
- Pin the callback to the configured application origin and exact callback
  path. All callback redirects use the fixed same-origin `/auth/result` path
  and a small server-owned outcome allowlist; caller return URLs are ignored.
- Keep provider token exchange and profile retrieval inside an injectable
  GitHub adapter. The adapter enforces timeout, response-size, status, and
  content-type bounds and returns only numeric id, login, name, and avatar URL.
- Treat exact `POST /api/auth/sign-out` as an idempotent Origin-protected
  terminal operation. It revokes only a valid presented session and returns the
  same empty success after expiry, revocation, malformed input, or absence.
- Persist the verified GitHub metadata refresh and new session in one database
  transaction. Repeated sign-in by one numeric GitHub identity retains the
  existing internal UUID.

## Consequences

The design remains provider-adapter and route-module reversible without a
general OAuth platform. An abusive public start caller can evict older pending
transactions at the cap, causing a safe restart rather than unbounded storage.
Live compatibility with GitHub remains unproven until credentialed staging
evidence is approved.
