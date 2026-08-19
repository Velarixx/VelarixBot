# ADR 0002: Internal user and server-side session boundary

Status: Accepted for DHV-17

## Context

VelarixBot's desktop HTTP API is loopback-only and authenticated by a
per-launch bearer. A later SaaS workflow will authenticate through GitHub, but
provider metadata can change and must not become the product-data identity.
The current product repositories and VM/workspace lookups are not user-scoped.

## Decision

- Identify a user internally with a generated UUID. Store GitHub's immutable
  numeric account ID as the unique provider key; login, name, and avatar are
  replaceable metadata.
- Store only SHA-256 digests of 256-bit random session tokens. Expiry and
  revocation are enforced during resolution, and every invalid credential has
  the same `null` result.
- Keep the new identity module independent of HTTP routes and the desktop
  launch bearer. This preserves the existing local security boundary and keeps
  the OAuth integration reversible.

## Consequences and next seam

A GitHub OAuth callback may later upsert the verified provider identity and
create a server-side session through this module. Before any SaaS endpoint is
exposed, follow-up work must propagate the resulting internal `user_id` through
every product repository and VM/workspace lookup and prove cross-user denial.

DHV-17 does not add OAuth routes, public binding, tenant columns, or complete
multi-user isolation. The alternative of using GitHub login or numeric ID as
the product primary key was rejected because it couples product ownership to a
provider and makes a later provider change or account-linking decision
irreversible.
