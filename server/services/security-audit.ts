import { createHash } from "node:crypto";

import type { SqliteDatabase } from "../db/sqlite-native.ts";
import type {
  CompletedGithubSignIn,
  GithubIdentity,
  IdentitySessions,
  IdentityUser,
} from "../identity.ts";
import type {
  DesktopAccessGrantsRepository,
  DesktopWorkspaceIdentity,
  MintedDesktopAccessGrant,
  OwnedDesktopAccessGrantsRepository,
  ResolvedDesktopAccessGrant,
} from "../repositories/desktop-access-grants.ts";
import type { EventLogRepository } from "../repositories/event-log.ts";

export const SECURITY_AUDIT_VERSION = 1;
export const SECURITY_AUDIT_SYSTEM_STREAM = "security-audit:system";

export const SECURITY_AUDIT_ACTIONS = [
  "oauth.start",
  "oauth.callback",
  "session.resolve",
  "session.revoke",
  "catalog.read",
  "catalog.create",
  "grant.issue",
  "grant.resolve",
  "grant.revoke",
] as const;

export const SECURITY_AUDIT_DECISIONS = ["allow", "deny"] as const;
export const SECURITY_AUDIT_REASONS = [
  "initiated",
  "completed",
  "invalid",
  "invalid_transaction",
  "malformed_callback",
  "provider_declined",
  "provider_failure",
  "expired",
  "replay",
  "unauthenticated",
  "invalid_request",
  "quota",
  "internal_failure",
  "created",
  "listed",
  "issued",
  "resolved",
  "revoked",
  "stale",
] as const;

export type SecurityAuditAction = (typeof SECURITY_AUDIT_ACTIONS)[number];
export type SecurityAuditDecision = (typeof SECURITY_AUDIT_DECISIONS)[number];
export type SecurityAuditReason = (typeof SECURITY_AUDIT_REASONS)[number];

export interface SecurityAuditDecisionInput {
  action: SecurityAuditAction;
  decision: SecurityAuditDecision;
  reason: SecurityAuditReason;
}

/** The only tenant-visible audit projection. Tenant IDs and event-log stream
 * metadata are intentionally absent; the stream is selected by a bound
 * tenant capability instead. */
export interface SecurityAuditEvent extends SecurityAuditDecisionInput {
  auditVersion: typeof SECURITY_AUDIT_VERSION;
  occurredAt: number;
}

export interface SecurityAuditRecorder {
  recordSystem(decision: SecurityAuditDecisionInput): void;
  recordTenant(ownerId: string, decision: SecurityAuditDecisionInput): void;
  decideSystem<T>(decide: () => { value: T; decision: SecurityAuditDecisionInput }): T;
  decideTenant<T>(
    ownerId: string,
    decide: () => { value: T; decision: SecurityAuditDecisionInput },
  ): T;
}

export interface AuditedIdentitySessions {
  completeGithubSignIn(
    githubIdentity: GithubIdentity,
    options?: { now?: number; maxAgeSeconds?: number },
  ): CompletedGithubSignIn;
  resolveSession(token: unknown, now?: number): IdentityUser | null;
  revokeSession(token: unknown, now?: number): boolean;
}

export interface SecurityAuditService extends SecurityAuditRecorder {
  sessions: AuditedIdentitySessions;
  desktopAccessGrants: DesktopAccessGrantsRepository;
  /** Owner-bound read: there is deliberately no cross-tenant list or count. */
  eventsForTenant(ownerId: string): SecurityAuditEvent[];
}

export class SecurityAuditWriteError extends Error {
  constructor() {
    super("security audit write failed");
    this.name = "SecurityAuditWriteError";
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const ACTIONS = new Set<string>(SECURITY_AUDIT_ACTIONS);
const DECISIONS = new Set<string>(SECURITY_AUDIT_DECISIONS);
const REASONS = new Set<string>(SECURITY_AUDIT_REASONS);

interface SessionRow {
  user_id: string;
  expires_at: number;
  revoked_at: number | null;
}

interface GrantAuditRow {
  provider_kind: string;
  machine_id: string;
  binding_generation: number;
  expires_at: number;
  revoked_at: number | null;
  current_generation: number | null;
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function tenantStream(ownerId: string): string {
  // The durable event-log metadata must not expose a stable internal user ID.
  return `security-audit:tenant:${digest(ownerId)}`;
}

function validTimestamp(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function assertOwnerId(ownerId: string): void {
  if (!UUID_PATTERN.test(ownerId)) throw new SecurityAuditWriteError();
}

function assertDecision(value: SecurityAuditDecisionInput): void {
  if (
    !value ||
    typeof value !== "object" ||
    !ACTIONS.has(value.action) ||
    !DECISIONS.has(value.decision) ||
    !REASONS.has(value.reason) ||
    Object.keys(value).some((key) => !["action", "decision", "reason"].includes(key))
  ) {
    throw new SecurityAuditWriteError();
  }
}

function projectedEvent(payload: Record<string, unknown>): SecurityAuditEvent | null {
  const candidate = {
    auditVersion: payload.auditVersion,
    action: payload.action,
    decision: payload.decision,
    reason: payload.reason,
    occurredAt: payload.occurredAt,
  };
  if (
    candidate.auditVersion !== SECURITY_AUDIT_VERSION ||
    typeof candidate.action !== "string" ||
    !ACTIONS.has(candidate.action) ||
    typeof candidate.decision !== "string" ||
    !DECISIONS.has(candidate.decision) ||
    typeof candidate.reason !== "string" ||
    !REASONS.has(candidate.reason) ||
    typeof candidate.occurredAt !== "number" ||
    !validTimestamp(candidate.occurredAt)
  ) {
    return null;
  }
  return candidate as SecurityAuditEvent;
}

export function createSecurityAuditService(input: {
  db: SqliteDatabase;
  eventLog: EventLogRepository;
  sessions: IdentitySessions;
  desktopAccessGrants: DesktopAccessGrantsRepository;
  now?: () => number;
}): SecurityAuditService {
  const now = input.now ?? (() => Date.now());
  const sessionByDigest = input.db.prepare<SessionRow>(
    "SELECT user_id, expires_at, revoked_at FROM sessions WHERE token_digest = ?",
  );
  const grantByDigest = input.db.prepare<GrantAuditRow>(
    `SELECT g.provider_kind, g.machine_id, g.binding_generation, g.expires_at, g.revoked_at,
            b.authorization_generation AS current_generation
     FROM desktop_access_grants g
     LEFT JOIN user_workspace_bindings b
       ON b.user_id = g.owner_id
      AND b.provider_kind = g.provider_kind
      AND b.machine_id = g.machine_id
     WHERE g.token_digest = ? AND g.owner_id = ?`,
  );
  const currentBinding = input.db.prepare<{ authorization_generation: number }>(
    `SELECT authorization_generation FROM user_workspace_bindings
     WHERE user_id = ? AND provider_kind = ? AND machine_id = ?`,
  );

  const write = (
    ownerId: string | null,
    decision: SecurityAuditDecisionInput,
  ): void => {
    try {
      assertDecision(decision);
      const occurredAt = now();
      if (!validTimestamp(occurredAt)) throw new Error("invalid audit clock");
      const streamId = ownerId === null ? SECURITY_AUDIT_SYSTEM_STREAM : tenantStream(ownerId);
      if (ownerId !== null) assertOwnerId(ownerId);
      input.eventLog.appendToStream(streamId, "security.audit", {
        kind: "security.audit",
        auditVersion: SECURITY_AUDIT_VERSION,
        action: decision.action,
        decision: decision.decision,
        reason: decision.reason,
        occurredAt,
      });
    } catch (error) {
      if (error instanceof SecurityAuditWriteError) throw error;
      throw new SecurityAuditWriteError();
    }
  };

  const recordSystem = (decision: SecurityAuditDecisionInput): void => write(null, decision);
  const recordTenant = (ownerId: string, decision: SecurityAuditDecisionInput): void => write(ownerId, decision);
  const decideSystem = <T>(decide: () => { value: T; decision: SecurityAuditDecisionInput }): T =>
    input.db.transaction(() => {
      const result = decide();
      write(null, result.decision);
      return result.value;
    })();
  const decideTenant = <T>(
    ownerId: string,
    decide: () => { value: T; decision: SecurityAuditDecisionInput },
  ): T =>
    input.db.transaction(() => {
      assertOwnerId(ownerId);
      const result = decide();
      write(ownerId, result.decision);
      return result.value;
    })();

  const sessionRow = (token: unknown): SessionRow | null =>
    typeof token === "string" && TOKEN_PATTERN.test(token)
      ? (sessionByDigest.get(digest(token)) ?? null)
      : null;

  const sessionDenial = (row: SessionRow | null, at: number): SecurityAuditReason => {
    if (!row) return "invalid";
    if (row.revoked_at !== null) return "replay";
    if (validTimestamp(at) && row.expires_at <= at) return "expired";
    return "invalid";
  };

  const sessions: AuditedIdentitySessions = {
    completeGithubSignIn(githubIdentity, options = {}) {
      return input.db.transaction(() => {
        const completed = input.sessions.completeGithubSignIn(githubIdentity, options);
        write(completed.user.id, { action: "oauth.callback", decision: "allow", reason: "completed" });
        return completed;
      })();
    },
    resolveSession(token, at = now()) {
      const resolved = input.sessions.resolveSession(token, at);
      if (resolved) {
        write(resolved.id, { action: "session.resolve", decision: "allow", reason: "resolved" });
        return resolved;
      }
      const row = sessionRow(token);
      write(row?.user_id ?? null, {
        action: "session.resolve",
        decision: "deny",
        reason: sessionDenial(row, at),
      });
      return null;
    },
    revokeSession(token, at = now()) {
      return input.db.transaction(() => {
        const before = sessionRow(token);
        const revoked = input.sessions.revokeSession(token, at);
        write(before?.user_id ?? null, {
          action: "session.revoke",
          decision: revoked ? "allow" : "deny",
          reason: revoked ? "revoked" : sessionDenial(before, at),
        });
        return revoked;
      })();
    },
  };

  const grantRow = (token: unknown, ownerId: string): GrantAuditRow | null =>
    typeof token === "string" && TOKEN_PATTERN.test(token)
      ? (grantByDigest.get(digest(token), ownerId) ?? null)
      : null;

  const staleGrant = (row: GrantAuditRow, expected: DesktopWorkspaceIdentity): boolean =>
    row.provider_kind !== expected.providerKind ||
    row.machine_id !== expected.machineId ||
    row.current_generation === null ||
    row.current_generation !== row.binding_generation;

  const grantDenial = (
    row: GrantAuditRow | null,
    expected: DesktopWorkspaceIdentity,
    at: number,
  ): SecurityAuditReason => {
    if (!row) return "invalid";
    if (row.revoked_at !== null) return "replay";
    if (validTimestamp(at) && row.expires_at <= at) return "expired";
    if (staleGrant(row, expected)) return "stale";
    return "invalid";
  };

  const auditedGrants: DesktopAccessGrantsRepository = {
    forOwner(ownerId) {
      const grants = input.desktopAccessGrants.forOwner(ownerId);
      if (!grants) return null;
      const owned: OwnedDesktopAccessGrantsRepository = {
        mint(expectedWorkspace, scope, options = {}): MintedDesktopAccessGrant | null {
          return decideTenant(ownerId, () => {
            const minted = grants.mint(expectedWorkspace, scope, options);
            const binding = currentBinding.get(ownerId, expectedWorkspace.providerKind, expectedWorkspace.machineId);
            return {
              value: minted,
              decision: {
                action: "grant.issue",
                decision: minted ? "allow" : "deny",
                reason: minted ? "issued" : (binding ? "invalid" : "stale"),
              },
            };
          });
        },
        resolve(token, expectedWorkspace, requiredScope, at = now()): ResolvedDesktopAccessGrant | null {
          const resolved = grants.resolve(token, expectedWorkspace, requiredScope, at);
          const row = resolved ? null : grantRow(token, ownerId);
          recordTenant(ownerId, {
            action: "grant.resolve",
            decision: resolved ? "allow" : "deny",
            reason: resolved ? "resolved" : grantDenial(row, expectedWorkspace, at),
          });
          return resolved;
        },
        revoke(token, expectedWorkspace, scope, at = now()): boolean {
          return decideTenant(ownerId, () => {
            const before = grantRow(token, ownerId);
            const revoked = grants.revoke(token, expectedWorkspace, scope, at);
            return {
              value: revoked,
              decision: {
                action: "grant.revoke",
                decision: revoked ? "allow" : "deny",
                reason: revoked ? "revoked" : grantDenial(before, expectedWorkspace, at),
              },
            };
          });
        },
        pruneExpired(at, limit) {
          return grants.pruneExpired(at, limit);
        },
      };
      return owned;
    },
  };

  return {
    recordSystem,
    recordTenant,
    decideSystem,
    decideTenant,
    sessions,
    desktopAccessGrants: auditedGrants,
    eventsForTenant(ownerId) {
      assertOwnerId(ownerId);
      return input.eventLog
        .replayAfter(tenantStream(ownerId), 0)
        .map(({ payload }) => projectedEvent(payload))
        .filter((event): event is SecurityAuditEvent => event !== null);
    },
  };
}
