import { createHash, randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "../config.ts";
import { defaultDbPath, openDatabase } from "../db/database.ts";
import { appliedMigrations, migrate } from "../db/migrations.ts";
import type { SqliteDatabase } from "../db/sqlite-native.ts";
import { IdentitySessions, type IdentityUser } from "../identity.ts";
import {
  createDesktopAccessGrantsRepository,
  DESKTOP_ACCESS_GRANT_DEFAULT_TTL_MS,
  DESKTOP_ACCESS_GRANT_MAX_PRUNE_LIMIT,
  DESKTOP_ACCESS_GRANT_MAX_TTL_MS,
  type DesktopWorkspaceIdentity,
} from "./desktop-access-grants.ts";
import { createRepositories } from "./index.ts";
import { createUserWorkspaceBindingsRepository } from "./user-workspace-bindings.ts";

const WORKSPACE_A: DesktopWorkspaceIdentity = { providerKind: "fake", machineId: "machine-a" };
const WORKSPACE_B: DesktopWorkspaceIdentity = { providerKind: "box", machineId: "machine-b" };

interface StoredGrantRow {
  token_digest: string;
  owner_id: string;
  provider_kind: string;
  machine_id: string;
  scope: string;
  binding_generation: number;
  created_at: number;
  expires_at: number;
  revoked_at: number | null;
}

describe("desktop access grants repository", () => {
  let db: SqliteDatabase;
  let userA: IdentityUser;
  let userB: IdentityUser;

  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    db = openDatabase(defaultDbPath());
    const identity = new IdentitySessions(db);
    userA = identity.upsertGithubIdentity({ githubId: 101, login: "owner-a" }, 100);
    userB = identity.upsertGithubIdentity({ githubId: 202, login: "owner-b" }, 100);
    const bindings = createUserWorkspaceBindingsRepository(db);
    bindings.forOwner(userA.id).record(WORKSPACE_A.providerKind, WORKSPACE_A.machineId, 1_000);
    bindings.forOwner(userB.id).record(WORKSPACE_B.providerKind, WORKSPACE_B.machineId, 1_000);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  });

  it("mints through repository composition, resolves exact authority, and persists only a digest", () => {
    const repository = createRepositories(db).desktopAccessGrants;
    const grants = repository.forOwner(userA.id);
    expect(grants).not.toBeNull();
    const minted = grants!.mint(WORKSPACE_A, "desktop:view", { now: 2_000 });

    expect(minted).toMatchObject({
      scope: "desktop:view",
      createdAt: 2_000,
      expiresAt: 2_000 + DESKTOP_ACCESS_GRANT_DEFAULT_TTL_MS,
    });
    expect(minted?.token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const row = db.prepare<StoredGrantRow>("SELECT * FROM desktop_access_grants").get();
    expect(row).toEqual({
      token_digest: createHash("sha256").update(minted!.token, "utf8").digest("hex"),
      owner_id: userA.id,
      provider_kind: WORKSPACE_A.providerKind,
      machine_id: WORKSPACE_A.machineId,
      scope: "desktop:view",
      binding_generation: 1,
      created_at: 2_000,
      expires_at: 2_000 + DESKTOP_ACCESS_GRANT_DEFAULT_TTL_MS,
      revoked_at: null,
    });
    expect(JSON.stringify(row)).not.toContain(minted!.token);
    expect(
      db.prepare<{ name: string }>("PRAGMA table_info(desktop_access_grants)").all().map(({ name }) => name),
    ).not.toContain("token");

    const resolved = grants!.resolve(minted!.token, WORKSPACE_A, "desktop:view", 2_001);
    expect(resolved).toEqual({
      ownerId: userA.id,
      providerKind: WORKSPACE_A.providerKind,
      machineId: WORKSPACE_A.machineId,
      scope: "desktop:view",
      createdAt: 2_000,
      expiresAt: 2_000 + DESKTOP_ACCESS_GRANT_DEFAULT_TTL_MS,
    });
    expect(resolved).not.toHaveProperty("token");
    expect(resolved).not.toHaveProperty("tokenDigest");
  });

  it("uses an exclusive expiry boundary and rejects unsafe issuance times and lifetimes", () => {
    const grants = createDesktopAccessGrantsRepository(db).forOwner(userA.id)!;
    const minted = grants.mint(WORKSPACE_A, "desktop:view", { now: 2_000, ttlMs: 10 })!;

    expect(grants.resolve(minted.token, WORKSPACE_A, "desktop:view", 2_009)).not.toBeNull();
    expect(grants.resolve(minted.token, WORKSPACE_A, "desktop:view", 2_010)).toBeNull();
    expect(grants.resolve(minted.token, WORKSPACE_A, "desktop:view", Number.NaN)).toBeNull();
    expect(grants.mint(WORKSPACE_A, "desktop:view", { now: -1 })).toBeNull();
    expect(grants.mint(WORKSPACE_A, "desktop:view", { now: Number.MAX_SAFE_INTEGER })).toBeNull();
    expect(grants.mint(WORKSPACE_A, "desktop:view", { now: 2_000, ttlMs: 0 })).toBeNull();
    expect(grants.mint(WORKSPACE_A, "desktop:view", { now: 2_000, ttlMs: DESKTOP_ACCESS_GRANT_MAX_TTL_MS + 1 })).toBeNull();
  });

  it("revokes exact current authority once and remains fail-closed and idempotent", () => {
    const grants = createDesktopAccessGrantsRepository(db).forOwner(userA.id)!;
    const minted = grants.mint(WORKSPACE_A, "desktop:control", { now: 2_000 })!;

    expect(grants.revoke(minted.token, WORKSPACE_A, "desktop:control", 2_001)).toBe(true);
    expect(grants.resolve(minted.token, WORKSPACE_A, "desktop:control", 2_002)).toBeNull();
    expect(grants.revoke(minted.token, WORKSPACE_A, "desktop:control", 2_003)).toBe(false);
    expect(
      db.prepare<{ revoked_at: number | null }>("SELECT revoked_at FROM desktop_access_grants").get()?.revoked_at,
    ).toBe(2_001);
  });

  it("bounds expired pruning and never deletes another owner's grants", () => {
    const repository = createDesktopAccessGrantsRepository(db);
    const ownerA = repository.forOwner(userA.id)!;
    const ownerB = repository.forOwner(userB.id)!;
    ownerA.mint(WORKSPACE_A, "desktop:view", { now: 2_000, ttlMs: 10 });
    ownerA.mint(WORKSPACE_A, "desktop:control", { now: 2_000, ttlMs: 20 });
    ownerB.mint(WORKSPACE_B, "desktop:view", { now: 2_000, ttlMs: 10 });

    expect(ownerA.pruneExpired(2_015, 1)).toBe(1);
    expect(countForOwner(userA.id)).toBe(1);
    expect(countForOwner(userB.id)).toBe(1);
    expect(ownerA.pruneExpired(3_000, 1)).toBe(1);
    expect(ownerA.pruneExpired(3_000, 1)).toBe(0);
    expect(countForOwner(userB.id)).toBe(1);
    expect(ownerB.pruneExpired(3_000, DESKTOP_ACCESS_GRANT_MAX_PRUNE_LIMIT + 1)).toBe(0);
    expect(countForOwner(userB.id)).toBe(1);
  });

  it("collapses malformed credentials, identities, scopes, and principals to null or false", () => {
    const repository = createDesktopAccessGrantsRepository(db);
    expect(repository.forOwner("not-an-internal-uuid")).toBeNull();
    const nonexistentOwner = repository.forOwner(randomUUID());
    expect(nonexistentOwner).not.toBeNull();
    expect(nonexistentOwner!.mint(WORKSPACE_A, "desktop:view", { now: 2_000 })).toBeNull();
    const grants = repository.forOwner(userA.id)!;

    expect(grants.mint({ ...WORKSPACE_A, machineId: "machine-z" }, "desktop:view", { now: 2_000 })).toBeNull();
    expect(grants.mint({ ...WORKSPACE_A, providerKind: "box" }, "desktop:view", { now: 2_000 })).toBeNull();
    expect(grants.mint({ providerKind: "Fake", machineId: "machine-a" }, "desktop:view", { now: 2_000 })).toBeNull();
    expect(grants.mint({ providerKind: "fake", machineId: "machine a" }, "desktop:view", { now: 2_000 })).toBeNull();
    expect(grants.mint(WORKSPACE_A, "desktop:admin", { now: 2_000 })).toBeNull();
    expect(grants.mint(WORKSPACE_A, "desktop:view", { now: 999 })).toBeNull();
    for (const token of [null, undefined, "", "a".repeat(42), "!".repeat(43), "a".repeat(44)]) {
      expect(grants.resolve(token, WORKSPACE_A, "desktop:view", 2_000)).toBeNull();
      expect(grants.revoke(token, WORKSPACE_A, "desktop:view", 2_000)).toBe(false);
    }
    expect(grants.resolve("a".repeat(43), { providerKind: "fake", machineId: "bad machine" }, "desktop:view", 2_000)).toBeNull();
    expect(grants.resolve("a".repeat(43), WORKSPACE_A, "desktop:admin", 2_000)).toBeNull();
    expect(grants.pruneExpired(-1)).toBe(0);
  });

  it("requires the correct tenant without exposing any grant enumeration or token-only resolver", () => {
    const repository = createDesktopAccessGrantsRepository(db);
    const ownerA = repository.forOwner(userA.id)!;
    const ownerB = repository.forOwner(userB.id)!;
    const mintedA = ownerA.mint(WORKSPACE_A, "desktop:view", { now: 2_000, ttlMs: 10 })!;
    ownerB.mint(WORKSPACE_B, "desktop:view", { now: 2_000, ttlMs: 10 });

    expect(ownerB.resolve(mintedA.token, WORKSPACE_A, "desktop:view", 2_001)).toBeNull();
    expect(ownerB.revoke(mintedA.token, WORKSPACE_A, "desktop:view", 2_001)).toBe(false);
    expect(ownerA.resolve(mintedA.token, WORKSPACE_A, "desktop:view", 2_001)).not.toBeNull();
    expect(Object.keys(repository)).toEqual(["forOwner"]);
    expect(Object.keys(ownerA).sort()).toEqual(["mint", "pruneExpired", "resolve", "revoke"]);

    expect(ownerA.pruneExpired(3_000)).toBe(1);
    expect(countForOwner(userA.id)).toBe(0);
    expect(countForOwner(userB.id)).toBe(1);
  });

  it("fails closed for wrong and stale machine/provider identities", () => {
    const bindings = createUserWorkspaceBindingsRepository(db).forOwner(userA.id);
    const grants = createDesktopAccessGrantsRepository(db).forOwner(userA.id)!;
    const minted = grants.mint(WORKSPACE_A, "desktop:view", { now: 2_000 })!;

    expect(grants.resolve(minted.token, { ...WORKSPACE_A, machineId: "machine-z" }, "desktop:view", 2_001)).toBeNull();
    expect(grants.resolve(minted.token, { ...WORKSPACE_A, providerKind: "box" }, "desktop:view", 2_001)).toBeNull();

    bindings.record("fake", "machine-z", 3_000);
    expect(grants.resolve(minted.token, WORKSPACE_A, "desktop:view", 3_001)).toBeNull();
    expect(grants.resolve(minted.token, { providerKind: "fake", machineId: "machine-z" }, "desktop:view", 3_001)).toBeNull();
  });

  it("invalidates equal-timestamp A -> B -> A rebounds with a non-reused generation", () => {
    const bindings = createUserWorkspaceBindingsRepository(db).forOwner(userA.id);
    const grants = createDesktopAccessGrantsRepository(db).forOwner(userA.id)!;
    const minted = grants.mint(WORKSPACE_A, "desktop:view", { now: 2_000 })!;
    const originalGeneration = bindings.get()!.authorizationGeneration;

    bindings.record("fake", "machine-z", 1_000);
    bindings.record(WORKSPACE_A.providerKind, WORKSPACE_A.machineId, 1_000);

    expect(bindings.get()).toMatchObject({
      providerKind: WORKSPACE_A.providerKind,
      machineId: WORKSPACE_A.machineId,
      updatedAt: 1_000,
      authorizationGeneration: originalGeneration + 2,
    });
    expect(grants.resolve(minted.token, WORKSPACE_A, "desktop:view", 2_001)).toBeNull();
    expect(grants.revoke(minted.token, WORKSPACE_A, "desktop:view", 2_001)).toBe(false);
  });

  it("invalidates raw-SQL delete -> recreate with a retained non-reused generation", () => {
    const bindings = createUserWorkspaceBindingsRepository(db).forOwner(userA.id);
    const grants = createDesktopAccessGrantsRepository(db).forOwner(userA.id)!;
    const minted = grants.mint(WORKSPACE_A, "desktop:view", { now: 2_000 })!;
    const originalGeneration = bindings.get()!.authorizationGeneration;

    expect(db.prepare("DELETE FROM user_workspace_bindings WHERE user_id = ?").run(userA.id).changes).toBe(1);
    expect(
      db.prepare<{ generation: number }>(
        "SELECT generation FROM user_workspace_binding_generations WHERE user_id = ?",
      ).get(userA.id),
    ).toEqual({ generation: originalGeneration + 1 });
    const reinsert = db.prepare(
      `INSERT INTO user_workspace_bindings(
         user_id, provider_kind, machine_id, authorization_generation, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    expect(() =>
      reinsert.run(
        userA.id,
        WORKSPACE_A.providerKind,
        WORKSPACE_A.machineId,
        originalGeneration,
        1_000,
        1_000,
      ),
    ).toThrow(/not current/i);
    expect(
      reinsert.run(
        userA.id,
        WORKSPACE_A.providerKind,
        WORKSPACE_A.machineId,
        originalGeneration + 1,
        1_000,
        1_000,
      ).changes,
    ).toBe(1);

    expect(bindings.get()!.authorizationGeneration).toBe(originalGeneration + 1);
    expect(grants.resolve(minted.token, WORKSPACE_A, "desktop:view", 2_001)).toBeNull();
    expect(grants.revoke(minted.token, WORKSPACE_A, "desktop:view", 2_001)).toBe(false);
  });

  it("uses exact allowlisted scopes and grants no implicit authority", () => {
    const grants = createDesktopAccessGrantsRepository(db).forOwner(userA.id)!;
    const view = grants.mint(WORKSPACE_A, "desktop:view", { now: 2_000 })!;
    const control = grants.mint(WORKSPACE_A, "desktop:control", { now: 2_000 })!;

    expect(grants.resolve(view.token, WORKSPACE_A, "desktop:control", 2_001)).toBeNull();
    expect(grants.resolve(control.token, WORKSPACE_A, "desktop:view", 2_001)).toBeNull();
    expect(grants.resolve(view.token, WORKSPACE_A, "desktop:unknown", 2_001)).toBeNull();
    expect(grants.revoke(view.token, WORKSPACE_A, "desktop:unknown", 2_001)).toBe(false);
  });

  it("enforces schema constraints and records the append-only migration once", () => {
    expect(migrate(db)).toEqual([]);
    expect(appliedMigrations(db).filter(({ name }) => name === "desktop-access-grants")).toHaveLength(1);
    expect(
      appliedMigrations(db).filter(({ name }) => name === "workspace-binding-authorization-generations"),
    ).toHaveLength(1);

    const insert = db.prepare(
      `INSERT INTO desktop_access_grants(
         token_digest, owner_id, provider_kind, machine_id, scope,
         binding_generation, created_at, expires_at, revoked_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const valid = ["a".repeat(64), userA.id, "fake", "machine-schema", "desktop:view", 1_000, 2_000, 2_010, null];
    expect(() => insert.run(...valid)).not.toThrow();
    expect(() => insert.run("not-a-digest", ...valid.slice(1))).toThrow(/CHECK/i);
    expect(() => insert.run("b".repeat(64), "not-a-uuid", ...valid.slice(2))).toThrow(/CHECK|FOREIGN KEY/i);
    expect(() => insert.run("c".repeat(64), userA.id, "Fake", ...valid.slice(3))).toThrow(/CHECK/i);
    expect(() => insert.run("d".repeat(64), userA.id, "fake", "bad machine", ...valid.slice(4))).toThrow(/CHECK/i);
    expect(() => insert.run("e".repeat(64), userA.id, "fake", "machine-e", "desktop:admin", ...valid.slice(5))).toThrow(/CHECK/i);
    expect(() => insert.run("0".repeat(64), userA.id, "fake", "machine-zero", "desktop:view", 0, 2_000, 2_010, null)).toThrow(/CHECK/i);
    expect(() => insert.run("f".repeat(64), userA.id, "fake", "machine-f", "desktop:view", 1_000, 2_000, 2_000, null)).toThrow(/CHECK/i);
    expect(() =>
      insert.run(
        "1".repeat(64),
        userA.id,
        "fake",
        "machine-one",
        "desktop:view",
        1_000,
        2_000,
        2_000 + DESKTOP_ACCESS_GRANT_MAX_TTL_MS + 1,
        null,
      ),
    ).toThrow(/CHECK/i);
  });

  function countForOwner(ownerId: string): number {
    return db.prepare<{ n: number }>("SELECT count(*) AS n FROM desktop_access_grants WHERE owner_id = ?").get(ownerId)?.n ?? 0;
  }
});
