// Owner-bound application boundary for short-lived browser desktop access.
// No route is wired here: a future authenticated caller must first bind an
// internal principal with forOwner(), and can never supply a provider,
// machine, owner, or binding generation to an operation.
import type { Repositories } from "../repositories/index.ts";
import {
  DESKTOP_ACCESS_GRANT_MAX_TTL_MS,
  DESKTOP_ACCESS_GRANT_SCOPES,
  type DesktopAccessGrantScope,
  type DesktopWorkspaceIdentity,
} from "../repositories/desktop-access-grants.ts";

const SCOPES = new Set<unknown>(DESKTOP_ACCESS_GRANT_SCOPES);

export interface DesktopAccessGrantPolicy {
  /** Active, unrevoked grants for the owner's current binding. */
  maxActiveGrantsPerOwner: number;
  defaultTtlMs: number;
  /** May narrow, but never widen, the repository's durable upper bound. */
  maxTtlMs: number;
}

export interface IssuedDesktopAccessGrantDto {
  /** The only credential field exposed, and only on successful issuance. */
  accessToken: string;
  scope: DesktopAccessGrantScope;
  issuedAt: number;
  expiresAt: number;
}

export interface ResolvedDesktopAccessGrantDto {
  scope: DesktopAccessGrantScope;
  issuedAt: number;
  expiresAt: number;
}

export type DesktopAccessGrantAuditEvent = Readonly<{
  type: "desktop_access_grant";
  action: "issue" | "resolve" | "revoke";
  outcome: "succeeded" | "absent" | "rejected";
  ownerId: string;
  scope?: DesktopAccessGrantScope;
  reason?: "invalid_request" | "no_current_binding" | "quota";
  at: number;
}>;

export interface DesktopAccessGrantService {
  /** Malformed principals fail closed before an owner capability exists. */
  forOwner(ownerId: string): OwnerDesktopAccessGrantService | null;
}

/** Deliberately reduced: no raw repository, owner, workspace, provider,
 * machine, generation, grant enumeration, or maintenance operation. */
export interface OwnerDesktopAccessGrantService {
  issue(scope: unknown, options?: { ttlMs?: number }): IssuedDesktopAccessGrantDto | null;
  resolve(accessToken: unknown, requiredScope: unknown): ResolvedDesktopAccessGrantDto | null;
  revoke(accessToken: unknown, scope: unknown): boolean;
}

export interface DesktopAccessGrantServiceOptions {
  repos: Repositories;
  policy: DesktopAccessGrantPolicy;
  /** Required, synchronous, metadata-only sink. A thrown audit error fails
   * closed; issuance and revocation are rolled back with their audit call. */
  audit: (event: DesktopAccessGrantAuditEvent) => void;
  now?: () => number;
}

interface CountRow {
  count: number;
}

function assertPolicy(policy: DesktopAccessGrantPolicy): void {
  if (!Number.isSafeInteger(policy.maxActiveGrantsPerOwner) || policy.maxActiveGrantsPerOwner < 1) {
    throw new TypeError("desktop access grant quota must be a positive integer");
  }
  if (!Number.isSafeInteger(policy.maxTtlMs) || policy.maxTtlMs < 1 || policy.maxTtlMs > DESKTOP_ACCESS_GRANT_MAX_TTL_MS) {
    throw new TypeError("desktop access grant maximum lifetime is invalid");
  }
  if (!Number.isSafeInteger(policy.defaultTtlMs) || policy.defaultTtlMs < 1 || policy.defaultTtlMs > policy.maxTtlMs) {
    throw new TypeError("desktop access grant default lifetime is invalid");
  }
}

function validScope(scope: unknown): scope is DesktopAccessGrantScope {
  return SCOPES.has(scope);
}

function validTtl(ttlMs: unknown, maximum: number): ttlMs is number {
  return Number.isSafeInteger(ttlMs) && (ttlMs as number) >= 1 && (ttlMs as number) <= maximum;
}

function workspaceOf(binding: { providerKind: string; machineId: string }): DesktopWorkspaceIdentity {
  return { providerKind: binding.providerKind, machineId: binding.machineId };
}

export function createDesktopAccessGrantService(options: DesktopAccessGrantServiceOptions): DesktopAccessGrantService {
  const { repos, policy, audit } = options;
  assertPolicy(policy);
  const clock = options.now ?? Date.now;
  const countActiveForCurrentBinding = repos.db.prepare<CountRow>(
    `SELECT count(*) AS count
     FROM desktop_access_grants g
     JOIN user_workspace_bindings b
       ON b.user_id = g.owner_id
      AND b.provider_kind = g.provider_kind
      AND b.machine_id = g.machine_id
      AND b.authorization_generation = g.binding_generation
     JOIN user_workspace_binding_generations bg
       ON bg.user_id = b.user_id
      AND bg.generation = b.authorization_generation
     WHERE g.owner_id = ?
       AND g.revoked_at IS NULL
       AND g.created_at <= ?
       AND g.expires_at > ?`,
  );

  function currentTime(): number {
    const value = clock();
    if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("desktop access grant clock is invalid");
    return value;
  }

  return {
    forOwner(ownerId) {
      const grants = repos.desktopAccessGrants.forOwner(ownerId);
      if (!grants) return null;
      const bindings = repos.userWorkspaceBindings.forOwner(ownerId);

      const issue = repos.db.transaction((scope: unknown, issueOptions: { ttlMs?: number } = {}) => {
        const at = currentTime();
        if (!validScope(scope)) {
          audit({ type: "desktop_access_grant", action: "issue", outcome: "rejected", ownerId, reason: "invalid_request", at });
          return null;
        }
        const ttlMs = issueOptions.ttlMs ?? policy.defaultTtlMs;
        if (!validTtl(ttlMs, policy.maxTtlMs) || at + ttlMs > Number.MAX_SAFE_INTEGER) {
          audit({ type: "desktop_access_grant", action: "issue", outcome: "rejected", ownerId, scope, reason: "invalid_request", at });
          return null;
        }
        const binding = bindings.get();
        if (!binding) {
          audit({ type: "desktop_access_grant", action: "issue", outcome: "absent", ownerId, scope, reason: "no_current_binding", at });
          return null;
        }
        const active = countActiveForCurrentBinding.get(ownerId, at, at)?.count ?? 0;
        if (!Number.isSafeInteger(active) || active >= policy.maxActiveGrantsPerOwner) {
          audit({ type: "desktop_access_grant", action: "issue", outcome: "rejected", ownerId, scope, reason: "quota", at });
          return null;
        }
        const minted = grants.mint(workspaceOf(binding), scope, { now: at, ttlMs });
        if (!minted) {
          audit({ type: "desktop_access_grant", action: "issue", outcome: "absent", ownerId, scope, reason: "no_current_binding", at });
          return null;
        }
        audit({ type: "desktop_access_grant", action: "issue", outcome: "succeeded", ownerId, scope, at });
        return {
          accessToken: minted.token,
          scope: minted.scope,
          issuedAt: minted.createdAt,
          expiresAt: minted.expiresAt,
        };
      });

      const revoke = repos.db.transaction((accessToken: unknown, scope: unknown) => {
        const at = currentTime();
        if (!validScope(scope)) {
          audit({ type: "desktop_access_grant", action: "revoke", outcome: "absent", ownerId, reason: "invalid_request", at });
          return false;
        }
        const binding = bindings.get();
        const revoked = binding ? grants.revoke(accessToken, workspaceOf(binding), scope, at) : false;
        audit({
          type: "desktop_access_grant",
          action: "revoke",
          outcome: revoked ? "succeeded" : "absent",
          ownerId,
          scope,
          ...(!binding ? { reason: "no_current_binding" as const } : {}),
          at,
        });
        return revoked;
      });

      return {
        issue,
        resolve(accessToken, requiredScope) {
          const at = currentTime();
          if (!validScope(requiredScope)) {
            audit({ type: "desktop_access_grant", action: "resolve", outcome: "absent", ownerId, reason: "invalid_request", at });
            return null;
          }
          const binding = bindings.get();
          const resolved = binding
            ? grants.resolve(accessToken, workspaceOf(binding), requiredScope, at)
            : null;
          audit({
            type: "desktop_access_grant",
            action: "resolve",
            outcome: resolved ? "succeeded" : "absent",
            ownerId,
            scope: requiredScope,
            ...(!binding ? { reason: "no_current_binding" as const } : {}),
            at,
          });
          return resolved
            ? { scope: resolved.scope, issuedAt: resolved.createdAt, expiresAt: resolved.expiresAt }
            : null;
        },
        revoke,
      };
    },
  };
}
