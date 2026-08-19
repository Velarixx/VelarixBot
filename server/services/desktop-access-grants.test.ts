import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "../config.ts";
import { defaultDbPath, openDatabase } from "../db/database.ts";
import type { SqliteDatabase } from "../db/sqlite-native.ts";
import { IdentitySessions, type IdentityUser } from "../identity.ts";
import { createRepositories, type Repositories } from "../repositories/index.ts";
import type { DesktopWorkspaceIdentity } from "../repositories/desktop-access-grants.ts";
import {
  createDesktopAccessGrantService,
  type DesktopAccessGrantAuditEvent,
  type DesktopAccessGrantPolicy,
  type DesktopAccessGrantService,
} from "./desktop-access-grants.ts";

const WORKSPACE_A: DesktopWorkspaceIdentity = { providerKind: "fake", machineId: "machine-a" };
const WORKSPACE_B: DesktopWorkspaceIdentity = { providerKind: "box", machineId: "machine-b" };
const POLICY: DesktopAccessGrantPolicy = {
  maxActiveGrantsPerOwner: 2,
  defaultTtlMs: 30_000,
  maxTtlMs: 60_000,
};

describe("owner-bound desktop access grant service", () => {
  let db: SqliteDatabase;
  let repos: Repositories;
  let userA: IdentityUser;
  let userB: IdentityUser;
  let now: number;
  let audit: DesktopAccessGrantAuditEvent[];
  let service: DesktopAccessGrantService;

  function makeService(overrides: Partial<{ policy: DesktopAccessGrantPolicy; audit: (event: DesktopAccessGrantAuditEvent) => void }> = {}) {
    return createDesktopAccessGrantService({
      repos,
      policy: overrides.policy ?? POLICY,
      audit: overrides.audit ?? ((event) => audit.push(event)),
      now: () => now,
    });
  }

  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    db = openDatabase(defaultDbPath());
    repos = createRepositories(db);
    const identity = new IdentitySessions(db);
    userA = identity.upsertGithubIdentity({ githubId: 101, login: "owner-a" }, 100);
    userB = identity.upsertGithubIdentity({ githubId: 202, login: "owner-b" }, 100);
    repos.userWorkspaceBindings.forOwner(userA.id).record(WORKSPACE_A.providerKind, WORKSPACE_A.machineId, 1_000);
    repos.userWorkspaceBindings.forOwner(userB.id).record(WORKSPACE_B.providerKind, WORKSPACE_B.machineId, 1_000);
    now = 2_000;
    audit = [];
    service = makeService();
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  });

  it("exposes a reduced facade and explicit credential and resolution DTOs", () => {
    expect(service.forOwner("not-an-internal-principal")).toBeNull();
    const grants = service.forOwner(userA.id)!;
    expect(Object.keys(service)).toEqual(["forOwner"]);
    expect(Object.keys(grants).sort()).toEqual(["issue", "resolve", "revoke"]);

    const issued = grants.issue("desktop:view")!;
    expect(issued).toEqual({
      accessToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      scope: "desktop:view",
      issuedAt: now,
      expiresAt: now + POLICY.defaultTtlMs,
    });
    expect(Object.keys(issued).sort()).toEqual(["accessToken", "expiresAt", "issuedAt", "scope"]);
    expect(grants.resolve(issued.accessToken, "desktop:view")).toEqual({
      scope: "desktop:view",
      issuedAt: now,
      expiresAt: now + POLICY.defaultTtlMs,
    });

    const serializedAudit = JSON.stringify(audit);
    expect(serializedAudit).not.toContain(issued.accessToken);
    expect(serializedAudit).not.toContain(WORKSPACE_A.machineId);
    expect(serializedAudit).not.toContain(WORKSPACE_A.providerKind);
    expect(audit).toEqual([
      { type: "desktop_access_grant", action: "issue", outcome: "succeeded", ownerId: userA.id, scope: "desktop:view", at: now },
      { type: "desktop_access_grant", action: "resolve", outcome: "succeeded", ownerId: userA.id, scope: "desktop:view", at: now },
    ]);
  });

  it("allows only exact scopes and enforces configured lifetime and durable quota", () => {
    const grants = service.forOwner(userA.id)!;
    expect(grants.issue("desktop:admin")).toBeNull();
    expect(grants.issue("desktop:view", { ttlMs: 0 })).toBeNull();
    expect(grants.issue("desktop:view", { ttlMs: POLICY.maxTtlMs + 1 })).toBeNull();

    const view = grants.issue("desktop:view", { ttlMs: 10_000 })!;
    const control = grants.issue("desktop:control", { ttlMs: 20_000 })!;
    expect(grants.issue("desktop:view")).toBeNull();
    expect(grants.resolve(view.accessToken, "desktop:control")).toBeNull();
    expect(grants.resolve(control.accessToken, "desktop:view")).toBeNull();

    expect(audit.filter((event) => event.reason === "quota")).toHaveLength(1);
    now += 10_000;
    expect(grants.issue("desktop:view")).not.toBeNull();
  });

  it("collapses malformed, foreign, expired, and revoked credentials to uniform absence across two tenants", () => {
    const ownerA = service.forOwner(userA.id)!;
    const ownerB = service.forOwner(userB.id)!;
    const issued = ownerA.issue("desktop:control", { ttlMs: 10 })!;

    for (const credential of [null, "", "a".repeat(42), "!".repeat(43), issued.accessToken]) {
      expect(ownerB.resolve(credential, "desktop:control")).toBeNull();
      expect(ownerB.revoke(credential, "desktop:control")).toBe(false);
    }
    expect(ownerA.resolve(issued.accessToken, "desktop:view")).toBeNull();
    expect(ownerA.revoke(issued.accessToken, "desktop:view")).toBe(false);
    expect(ownerA.resolve(issued.accessToken, "desktop:control")).not.toBeNull();
    expect(ownerA.revoke(issued.accessToken, "desktop:control")).toBe(true);
    expect(ownerA.resolve(issued.accessToken, "desktop:control")).toBeNull();
    expect(ownerA.revoke(issued.accessToken, "desktop:control")).toBe(false);

    const expiring = ownerA.issue("desktop:view", { ttlMs: 1 })!;
    now += 1;
    expect(ownerA.resolve(expiring.accessToken, "desktop:view")).toBeNull();
    expect(ownerA.revoke(expiring.accessToken, "desktop:view")).toBe(false);
  });

  it("invalidates stale and equal-identity ABA grants without exposing workspace identity", () => {
    const grants = service.forOwner(userA.id)!;
    const bindings = repos.userWorkspaceBindings.forOwner(userA.id);
    const stale = grants.issue("desktop:view")!;

    bindings.record("box", "machine-z", now);
    bindings.record(WORKSPACE_A.providerKind, WORKSPACE_A.machineId, now);

    expect(grants.resolve(stale.accessToken, "desktop:view")).toBeNull();
    expect(grants.revoke(stale.accessToken, "desktop:view")).toBe(false);
    const fresh = grants.issue("desktop:view")!;
    expect(grants.resolve(fresh.accessToken, "desktop:view")).not.toBeNull();
    expect(JSON.stringify(audit)).not.toContain("machine-z");
  });

  it("holds the quota under concurrent issue attempts", async () => {
    const grants = service.forOwner(userA.id)!;
    const outcomes = await Promise.all(
      Array.from({ length: 12 }, async () => {
        await Promise.resolve();
        return grants.issue("desktop:view");
      }),
    );

    expect(outcomes.filter(Boolean)).toHaveLength(POLICY.maxActiveGrantsPerOwner);
    expect(
      db.prepare<{ count: number }>("SELECT count(*) AS count FROM desktop_access_grants WHERE owner_id = ?").get(userA.id)?.count,
    ).toBe(POLICY.maxActiveGrantsPerOwner);
  });

  it("survives restart with resolution, revocation, and quota state intact", () => {
    const restartPolicy = { ...POLICY, maxActiveGrantsPerOwner: 1 };
    const beforeRestart = makeService({ policy: restartPolicy }).forOwner(userA.id)!;
    const issued = beforeRestart.issue("desktop:view")!;
    db.close();

    db = openDatabase(defaultDbPath());
    repos = createRepositories(db);
    const afterRestart = makeService({ policy: restartPolicy }).forOwner(userA.id)!;
    expect(afterRestart.resolve(issued.accessToken, "desktop:view")).toEqual({
      scope: "desktop:view",
      issuedAt: now,
      expiresAt: now + restartPolicy.defaultTtlMs,
    });
    expect(afterRestart.issue("desktop:view")).toBeNull();
    expect(afterRestart.revoke(issued.accessToken, "desktop:view")).toBe(true);
    expect(afterRestart.resolve(issued.accessToken, "desktop:view")).toBeNull();
    expect(afterRestart.issue("desktop:view")).not.toBeNull();
  });

  it("fails closed when audit recording fails and rolls back mutations", () => {
    const failing = makeService({
      audit: () => {
        throw new Error("audit unavailable");
      },
    }).forOwner(userA.id)!;

    expect(() => failing.issue("desktop:view")).toThrow(/audit unavailable/);
    expect(db.prepare<{ count: number }>("SELECT count(*) AS count FROM desktop_access_grants").get()?.count).toBe(0);

    const issued = service.forOwner(userA.id)!.issue("desktop:view")!;
    expect(() => failing.revoke(issued.accessToken, "desktop:view")).toThrow(/audit unavailable/);
    expect(service.forOwner(userA.id)!.resolve(issued.accessToken, "desktop:view")).not.toBeNull();
  });

  it("treats a valid but nonexistent or unbound owner as absent", () => {
    const missing = service.forOwner(randomUUID())!;
    expect(missing.issue("desktop:view")).toBeNull();
    expect(missing.resolve("a".repeat(43), "desktop:view")).toBeNull();
    expect(missing.revoke("a".repeat(43), "desktop:view")).toBe(false);

    repos.userWorkspaceBindings.forOwner(userA.id).delete(WORKSPACE_A.providerKind, WORKSPACE_A.machineId);
    expect(service.forOwner(userA.id)!.issue("desktop:view")).toBeNull();
  });

  it("rejects unsafe policy widening at construction", () => {
    expect(() => makeService({ policy: { ...POLICY, maxActiveGrantsPerOwner: 0 } })).toThrow(/quota/);
    expect(() => makeService({ policy: { ...POLICY, defaultTtlMs: POLICY.maxTtlMs + 1 } })).toThrow(/default lifetime/);
    expect(() => makeService({ policy: { ...POLICY, maxTtlMs: 300_001 } })).toThrow(/maximum lifetime/);
  });
});
