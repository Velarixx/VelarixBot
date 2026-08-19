// Durable, server-only grants for a future browser remote-desktop boundary.
// This module intentionally has no route, provider, URL, or VM dependency.
// Security decisions kept explicit here:
// - opaque 256-bit tokens; only SHA-256 digests cross the database boundary;
// - exact-match scopes (control does not implicitly include view);
// - every operation is owner-bound, and resolution also requires the caller's
//   expected current workspace identity and scope;
// - a durable monotonic binding generation prevents timestamp ABA and
//   delete/recreate grant revival.
import { createHash, randomBytes } from "node:crypto";

import type { SqliteDatabase } from "../db/sqlite-native.ts";

export const DESKTOP_ACCESS_GRANT_DEFAULT_TTL_MS = 60_000;
export const DESKTOP_ACCESS_GRANT_MAX_TTL_MS = 5 * 60_000;
export const DESKTOP_ACCESS_GRANT_SCOPES = ["desktop:view", "desktop:control"] as const;
export const DESKTOP_ACCESS_GRANT_DEFAULT_PRUNE_LIMIT = 100;
export const DESKTOP_ACCESS_GRANT_MAX_PRUNE_LIMIT = 1_000;

const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROVIDER_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const MACHINE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/;
const SCOPES = new Set<string>(DESKTOP_ACCESS_GRANT_SCOPES);

export type DesktopAccessGrantScope = (typeof DESKTOP_ACCESS_GRANT_SCOPES)[number];

export interface DesktopWorkspaceIdentity {
  providerKind: string;
  machineId: string;
}

export interface MintedDesktopAccessGrant {
  token: string;
  scope: DesktopAccessGrantScope;
  createdAt: number;
  expiresAt: number;
}

export interface ResolvedDesktopAccessGrant {
  ownerId: string;
  providerKind: string;
  machineId: string;
  scope: DesktopAccessGrantScope;
  createdAt: number;
  expiresAt: number;
}

interface GrantRow {
  owner_id: string;
  provider_kind: string;
  machine_id: string;
  scope: DesktopAccessGrantScope;
  created_at: number;
  expires_at: number;
}

interface MintedRow {
  binding_generation: number;
}

export interface DesktopAccessGrantsRepository {
  /** Invalid principals fail closed before an owner-bound capability exists. */
  forOwner(ownerId: string): OwnedDesktopAccessGrantsRepository | null;
}

export interface OwnedDesktopAccessGrantsRepository {
  mint(
    expectedWorkspace: DesktopWorkspaceIdentity,
    scope: string,
    options?: { now?: number; ttlMs?: number },
  ): MintedDesktopAccessGrant | null;
  resolve(
    token: unknown,
    expectedWorkspace: DesktopWorkspaceIdentity,
    requiredScope: string,
    now?: number,
  ): ResolvedDesktopAccessGrant | null;
  revoke(
    token: unknown,
    expectedWorkspace: DesktopWorkspaceIdentity,
    scope: string,
    now?: number,
  ): boolean;
  /** Deletes at most `limit` expired rows belonging to this owner. */
  pruneExpired(now?: number, limit?: number): number;
}

function validTimestamp(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function validLifetime(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= DESKTOP_ACCESS_GRANT_MAX_TTL_MS;
}

function validWorkspaceIdentity(value: DesktopWorkspaceIdentity): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    PROVIDER_PATTERN.test(value.providerKind) &&
    MACHINE_PATTERN.test(value.machineId)
  );
}

function validScope(value: string): value is DesktopAccessGrantScope {
  return typeof value === "string" && SCOPES.has(value);
}

function validToken(token: unknown): token is string {
  return typeof token === "string" && TOKEN_PATTERN.test(token);
}

function digest(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function toResolvedGrant(row: GrantRow): ResolvedDesktopAccessGrant {
  return {
    ownerId: row.owner_id,
    providerKind: row.provider_kind,
    machineId: row.machine_id,
    scope: row.scope,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

export function createDesktopAccessGrantsRepository(db: SqliteDatabase): DesktopAccessGrantsRepository {
  const mintForCurrentBinding = db.prepare<MintedRow>(
    `INSERT INTO desktop_access_grants(
       token_digest, owner_id, provider_kind, machine_id, scope,
       binding_generation, created_at, expires_at, revoked_at
     )
     SELECT ?, b.user_id, b.provider_kind, b.machine_id, ?, b.authorization_generation, ?, ?, NULL
     FROM user_workspace_bindings b
     JOIN user_workspace_binding_generations bg
       ON bg.user_id = b.user_id
      AND bg.generation = b.authorization_generation
     WHERE b.user_id = ?
       AND b.provider_kind = ?
       AND b.machine_id = ?
       AND typeof(b.created_at) = 'integer'
       AND typeof(b.updated_at) = 'integer'
       AND typeof(b.authorization_generation) = 'integer'
       AND b.authorization_generation BETWEEN 1 AND ?
       AND b.created_at BETWEEN 0 AND ?
       AND b.updated_at BETWEEN b.created_at AND ?
       AND b.updated_at <= ?
     RETURNING binding_generation`,
  );
  const resolveForCurrentBinding = db.prepare<GrantRow>(
    `SELECT g.owner_id, g.provider_kind, g.machine_id, g.scope, g.created_at, g.expires_at
     FROM desktop_access_grants g
     JOIN user_workspace_bindings b
       ON b.user_id = g.owner_id
      AND b.provider_kind = g.provider_kind
      AND b.machine_id = g.machine_id
      AND b.authorization_generation = g.binding_generation
     JOIN user_workspace_binding_generations bg
       ON bg.user_id = b.user_id
      AND bg.generation = b.authorization_generation
     WHERE g.token_digest = ?
       AND g.owner_id = ?
       AND g.provider_kind = ?
       AND g.machine_id = ?
       AND g.scope = ?
       AND g.revoked_at IS NULL
       AND g.created_at <= ?
       AND g.expires_at > ?
       AND g.expires_at - g.created_at BETWEEN 1 AND ?`,
  );
  const revokeForCurrentBinding = db.prepare(
    `UPDATE desktop_access_grants
     SET revoked_at = ?
     WHERE token_digest = ?
       AND owner_id = ?
       AND provider_kind = ?
       AND machine_id = ?
       AND scope = ?
       AND revoked_at IS NULL
       AND created_at <= ?
       AND expires_at > ?
       AND EXISTS (
         SELECT 1
         FROM user_workspace_bindings b
         JOIN user_workspace_binding_generations bg
           ON bg.user_id = b.user_id
          AND bg.generation = b.authorization_generation
         WHERE b.user_id = desktop_access_grants.owner_id
           AND b.provider_kind = desktop_access_grants.provider_kind
           AND b.machine_id = desktop_access_grants.machine_id
           AND b.authorization_generation = desktop_access_grants.binding_generation
       )`,
  );
  const pruneExpiredForOwner = db.prepare(
    `DELETE FROM desktop_access_grants
     WHERE token_digest IN (
       SELECT token_digest
       FROM desktop_access_grants
       WHERE owner_id = ? AND expires_at <= ?
       ORDER BY expires_at, token_digest
       LIMIT ?
     )
       AND owner_id = ?`,
  );

  return {
    forOwner(ownerId) {
      if (typeof ownerId !== "string" || !UUID_PATTERN.test(ownerId)) return null;
      return {
        mint(expectedWorkspace, scope, options = {}) {
          const now = options.now ?? Date.now();
          const ttlMs = options.ttlMs ?? DESKTOP_ACCESS_GRANT_DEFAULT_TTL_MS;
          if (!validWorkspaceIdentity(expectedWorkspace) || !validScope(scope) || !validTimestamp(now) || !validLifetime(ttlMs)) {
            return null;
          }
          const expiresAt = now + ttlMs;
          if (!Number.isSafeInteger(expiresAt)) return null;
          const token = randomBytes(TOKEN_BYTES).toString("base64url");
          const inserted = mintForCurrentBinding.get(
            digest(token),
            scope,
            now,
            expiresAt,
            ownerId,
            expectedWorkspace.providerKind,
            expectedWorkspace.machineId,
            Number.MAX_SAFE_INTEGER,
            Number.MAX_SAFE_INTEGER,
            Number.MAX_SAFE_INTEGER,
            now,
          );
          return inserted ? { token, scope, createdAt: now, expiresAt } : null;
        },
        resolve(token, expectedWorkspace, requiredScope, now = Date.now()) {
          if (
            !validToken(token) ||
            !validWorkspaceIdentity(expectedWorkspace) ||
            !validScope(requiredScope) ||
            !validTimestamp(now)
          ) {
            return null;
          }
          const row = resolveForCurrentBinding.get(
            digest(token),
            ownerId,
            expectedWorkspace.providerKind,
            expectedWorkspace.machineId,
            requiredScope,
            now,
            now,
            DESKTOP_ACCESS_GRANT_MAX_TTL_MS,
          );
          return row ? toResolvedGrant(row) : null;
        },
        revoke(token, expectedWorkspace, scope, now = Date.now()) {
          if (!validToken(token) || !validWorkspaceIdentity(expectedWorkspace) || !validScope(scope) || !validTimestamp(now)) {
            return false;
          }
          return (
            revokeForCurrentBinding.run(
              now,
              digest(token),
              ownerId,
              expectedWorkspace.providerKind,
              expectedWorkspace.machineId,
              scope,
              now,
              now,
            ).changes > 0
          );
        },
        pruneExpired(now = Date.now(), limit = DESKTOP_ACCESS_GRANT_DEFAULT_PRUNE_LIMIT) {
          if (
            !validTimestamp(now) ||
            !Number.isSafeInteger(limit) ||
            limit < 1 ||
            limit > DESKTOP_ACCESS_GRANT_MAX_PRUNE_LIMIT
          ) {
            return 0;
          }
          return pruneExpiredForOwner.run(ownerId, now, limit, ownerId).changes;
        },
      };
    },
  };
}
