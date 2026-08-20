import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase } from "../db/database.ts";
import type { SqliteDatabase } from "../db/sqlite-native.ts";
import { IdentitySessions } from "../identity.ts";
import { createRepositories, type Repositories } from "../repositories/index.ts";
import type { DesktopWorkspaceIdentity } from "../repositories/desktop-access-grants.ts";
import { createBotsService } from "./bots.ts";
import {
  createSecurityAuditService,
  SECURITY_AUDIT_SYSTEM_STREAM,
  SecurityAuditWriteError,
  type SecurityAuditEvent,
} from "./security-audit.ts";

const WORKSPACE_A: DesktopWorkspaceIdentity = { providerKind: "fake", machineId: "machine-a-secret" };
const WORKSPACE_A_NEXT: DesktopWorkspaceIdentity = { providerKind: "fake", machineId: "machine-next-secret" };

describe("redacted SaaS security audit", () => {
  let db: SqliteDatabase;
  let repos: Repositories;
  let rawSessions: IdentitySessions;
  let ownerA: string;
  let ownerB: string;
  let auditNow: number;

  beforeEach(() => {
    db = openDatabase(":memory:");
    repos = createRepositories(db);
    rawSessions = new IdentitySessions(db);
    ownerA = rawSessions.upsertGithubIdentity({ githubId: 101, login: "audit-a" }, 1_000).id;
    ownerB = rawSessions.upsertGithubIdentity({ githubId: 202, login: "audit-b" }, 1_000).id;
    repos.userWorkspaceBindings.forOwner(ownerA).record(WORKSPACE_A.providerKind, WORKSPACE_A.machineId, 1_000);
    auditNow = 10_000;
  });

  afterEach(() => db.close());

  function service(eventLog = repos.eventLog) {
    return createSecurityAuditService({
      db,
      eventLog,
      sessions: rawSessions,
      desktopAccessGrants: repos.desktopAccessGrants,
      now: () => auditNow++,
    });
  }

  it("records exact OAuth/session/catalog/grant decisions with a stable redacted schema and tenant isolation", () => {
    const audit = service();
    audit.recordSystem({ action: "oauth.start", decision: "allow", reason: "initiated" });
    audit.recordSystem({ action: "oauth.callback", decision: "deny", reason: "invalid_transaction" });

    const expired = audit.sessions.completeGithubSignIn(
      {
        githubId: 101,
        login: "provider-login-secret",
        name: "provider-payload-secret",
        avatarUrl: "https://provider.test/private/path?token=provider-token-secret",
      },
      { now: 2_000, maxAgeSeconds: 1 },
    ).session;
    expect(audit.sessions.resolveSession(expired.token, 3_000)).toBeNull();

    const revoked = rawSessions.createSession(ownerA, { now: 4_000, maxAgeSeconds: 10 });
    expect(audit.sessions.resolveSession(revoked.token, 4_000)?.id).toBe(ownerA);
    expect(audit.sessions.revokeSession(revoked.token, 4_001)).toBe(true);
    expect(audit.sessions.resolveSession(revoked.token, 4_002)).toBeNull();

    audit.recordTenant(ownerA, { action: "catalog.read", decision: "allow", reason: "listed" });
    audit.recordTenant(ownerA, { action: "catalog.create", decision: "allow", reason: "created" });
    audit.recordTenant(ownerA, { action: "catalog.create", decision: "deny", reason: "quota" });

    const grants = audit.desktopAccessGrants.forOwner(ownerA)!;
    const expiredGrant = grants.mint(WORKSPACE_A, "desktop:view", { now: 6_000, ttlMs: 10 })!;
    expect(grants.resolve(expiredGrant.token, WORKSPACE_A, "desktop:view", 6_010)).toBeNull();
    const staleGrant = grants.mint(WORKSPACE_A, "desktop:view", { now: 7_000 })!;
    repos.userWorkspaceBindings
      .forOwner(ownerA)
      .record(WORKSPACE_A_NEXT.providerKind, WORKSPACE_A_NEXT.machineId, 8_000);
    expect(grants.resolve(staleGrant.token, WORKSPACE_A, "desktop:view", 8_001)).toBeNull();
    const revokedGrant = grants.mint(WORKSPACE_A_NEXT, "desktop:control", { now: 9_000 })!;
    expect(grants.revoke(revokedGrant.token, WORKSPACE_A_NEXT, "desktop:control", 9_001)).toBe(true);

    const expectedA: Array<Pick<SecurityAuditEvent, "action" | "decision" | "reason">> = [
      { action: "oauth.callback", decision: "allow", reason: "completed" },
      { action: "session.resolve", decision: "deny", reason: "expired" },
      { action: "session.resolve", decision: "allow", reason: "resolved" },
      { action: "session.revoke", decision: "allow", reason: "revoked" },
      { action: "session.resolve", decision: "deny", reason: "replay" },
      { action: "catalog.read", decision: "allow", reason: "listed" },
      { action: "catalog.create", decision: "allow", reason: "created" },
      { action: "catalog.create", decision: "deny", reason: "quota" },
      { action: "grant.issue", decision: "allow", reason: "issued" },
      { action: "grant.resolve", decision: "deny", reason: "expired" },
      { action: "grant.issue", decision: "allow", reason: "issued" },
      { action: "grant.resolve", decision: "deny", reason: "stale" },
      { action: "grant.issue", decision: "allow", reason: "issued" },
      { action: "grant.revoke", decision: "allow", reason: "revoked" },
    ];
    const tenantA = audit.eventsForTenant(ownerA);
    expect(tenantA).toHaveLength(14);
    expect(tenantA.map(({ action, decision, reason }) => ({ action, decision, reason }))).toEqual(expectedA);
    expect(tenantA.every((event) => Object.keys(event).sort().join(",") === "action,auditVersion,decision,occurredAt,reason")).toBe(true);

    // Adding a foreign event changes neither this tenant's rows nor its count.
    audit.recordTenant(ownerB, { action: "catalog.read", decision: "allow", reason: "listed" });
    expect(audit.eventsForTenant(ownerA)).toEqual(tenantA);
    expect(audit.eventsForTenant(ownerB)).toHaveLength(1);
    expect(() => audit.eventsForTenant("not-an-internal-tenant")).toThrow(SecurityAuditWriteError);

    const system = repos.eventLog.replayAfter(SECURITY_AUDIT_SYSTEM_STREAM, 0);
    expect(system).toHaveLength(2);
    expect(system.map(({ payload }) => [payload.action, payload.decision, payload.reason])).toEqual([
      ["oauth.start", "allow", "initiated"],
      ["oauth.callback", "deny", "invalid_transaction"],
    ]);

    const rows = db.prepare<{ stream_id: string; data: string }>(
      "SELECT stream_id, data FROM event_log WHERE type = 'security.audit' ORDER BY seq",
    ).all();
    expect(rows).toHaveLength(17);
    for (const row of rows) {
      const payload = JSON.parse(row.data) as Record<string, unknown>;
      expect(Object.keys(payload).sort()).toEqual(
        ["action", "auditVersion", "decision", "kind", "occurredAt", "reason", "schemaVersion", "sequence", "streamId"].sort(),
      );
      expect(payload.kind).toBe("security.audit");
      expect(row.stream_id).not.toContain(ownerA);
      expect(row.stream_id).not.toContain(ownerB);
    }
    const serialized = JSON.stringify(rows);
    for (const forbidden of [
      ownerA,
      ownerB,
      expired.token,
      revoked.token,
      expiredGrant.token,
      staleGrant.token,
      revokedGrant.token,
      "provider-login-secret",
      "provider-payload-secret",
      "provider-token-secret",
      WORKSPACE_A.providerKind,
      WORKSPACE_A.machineId,
      WORKSPACE_A_NEXT.machineId,
      "private/path",
      "stack",
      "cookie",
      "state",
      "code",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("fails closed and rolls back security mutations when the audit append fails", () => {
    const failingEventLog: Repositories["eventLog"] = {
      ...repos.eventLog,
      appendToStream() {
        throw new Error("database path /secret audit stack token=secret");
      },
    };
    const audit = service(failingEventLog);

    const usersBefore = db.prepare<{ n: number }>("SELECT count(*) AS n FROM users").get()!.n;
    expect(() =>
      audit.sessions.completeGithubSignIn({ githubId: 303, login: "must-rollback" }, { now: 2_000 }),
    ).toThrow(SecurityAuditWriteError);
    expect(db.prepare<{ n: number }>("SELECT count(*) AS n FROM users").get()!.n).toBe(usersBefore);

    const session = rawSessions.createSession(ownerA, { now: 3_000, maxAgeSeconds: 10 });
    expect(() => audit.sessions.revokeSession(session.token, 3_001)).toThrow(SecurityAuditWriteError);
    expect(rawSessions.resolveSession(session.token, 3_002)?.id).toBe(ownerA);

    expect(() =>
      audit.desktopAccessGrants.forOwner(ownerA)!.mint(WORKSPACE_A, "desktop:view", { now: 4_000 }),
    ).toThrow(SecurityAuditWriteError);
    expect(db.prepare<{ n: number }>("SELECT count(*) AS n FROM desktop_access_grants").get()!.n).toBe(0);

    const bots = createBotsService({
      repos,
      defaultSelection: () => ({ instanceId: "fake", model: "fake-model" }),
    });
    expect(() =>
      audit.decideTenant(ownerA, () => {
        const created = bots.forOwner(ownerA).createBotWithinQuota(5);
        return {
          value: created,
          decision: { action: "catalog.create", decision: "allow", reason: "created" },
        };
      }),
    ).toThrow(SecurityAuditWriteError);
    expect(bots.forOwner(ownerA).count()).toBe(0);

    const expired = rawSessions.createSession(ownerA, { now: 5_000, maxAgeSeconds: 1 });
    expect(() => audit.sessions.resolveSession(expired.token, 6_000)).toThrow(SecurityAuditWriteError);
    const live = rawSessions.createSession(ownerA, { now: 7_000, maxAgeSeconds: 10 });
    expect(() => audit.sessions.resolveSession(live.token, 7_001)).toThrow(SecurityAuditWriteError);
  });

  it("enforces append-only audit rows below the repository layer", () => {
    const audit = service();
    expect(() =>
      audit.recordTenant(ownerA, {
        action: "catalog.read",
        decision: "allow",
        reason: "listed",
        token: "must-never-enter-audit",
      } as never),
    ).toThrow(SecurityAuditWriteError);
    expect(() =>
      audit.recordTenant(ownerA, {
        action: "unknown.action",
        decision: "allow",
        reason: "listed",
      } as never),
    ).toThrow(SecurityAuditWriteError);
    audit.recordTenant(ownerA, { action: "catalog.read", decision: "allow", reason: "listed" });
    const row = db.prepare<{ seq: number }>("SELECT seq FROM event_log WHERE type = 'security.audit'").get()!;
    expect(() => db.prepare("UPDATE event_log SET type = 'tampered' WHERE seq = ?").run(row.seq)).toThrow(/append-only/i);
    expect(() => db.prepare("DELETE FROM event_log WHERE seq = ?").run(row.seq)).toThrow(/append-only/i);
    expect(() =>
      db.prepare(
        `INSERT OR REPLACE INTO event_log(
           seq, event_id, thread_id, type, created_at, data, stream_id, sequence, schema_version
         )
         SELECT seq, event_id, thread_id, 'other', created_at, data, stream_id, sequence, schema_version
         FROM event_log WHERE seq = ?`,
      ).run(row.seq),
    ).toThrow(/append-only/i);
    expect(db.prepare<{ n: number }>("SELECT count(*) AS n FROM event_log WHERE type = 'security.audit'").get()!.n).toBe(1);
  });
});
