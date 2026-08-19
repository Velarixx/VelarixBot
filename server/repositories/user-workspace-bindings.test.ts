import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "../config.ts";
import { defaultDbPath, openDatabase } from "../db/database.ts";
import type { SqliteDatabase } from "../db/sqlite-native.ts";
import { IdentitySessions, type IdentityUser } from "../identity.ts";
import { createComputerBindingsRepository } from "./computer-bindings.ts";
import { createRepositories } from "./index.ts";
import { createUserWorkspaceBindingsRepository } from "./user-workspace-bindings.ts";

describe("user workspace bindings repository", () => {
  let db: SqliteDatabase;

  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    db = openDatabase(defaultDbPath());
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  });

  function users(): [IdentityUser, IdentityUser] {
    const identity = new IdentitySessions(db);
    return [
      identity.upsertGithubIdentity({ githubId: 101, login: "owner-a" }, 1_000),
      identity.upsertGithubIdentity({ githubId: 202, login: "owner-b" }, 1_000),
    ];
  }

  it("reuses and updates one owner binding durably without touching the legacy desktop seam", () => {
    const [userA] = users();
    const legacy = createComputerBindingsRepository(db);
    legacy.record("legacy-bot", "legacy-machine", 500);
    const binding = createRepositories(db).userWorkspaceBindings.forOwner(userA.id);

    binding.record("fake", "machine-a", 1_000);
    expect(binding.get()).toEqual({
      userId: userA.id,
      providerKind: "fake",
      machineId: "machine-a",
      createdAt: 1_000,
      updatedAt: 1_000,
    });
    binding.record("fake", "machine-a", 2_000);
    binding.record("box", "machine-a2", 3_000);
    expect(binding.get()).toMatchObject({
      providerKind: "box",
      machineId: "machine-a2",
      createdAt: 1_000,
      updatedAt: 3_000,
    });
    expect(db.prepare<{ n: number }>("SELECT count(*) AS n FROM user_workspace_bindings").get()?.n).toBe(1);
    expect(legacy.get("legacy-bot")).toMatchObject({ boxId: "legacy-machine", createdAt: 500, updatedAt: 500 });

    db.close();
    db = openDatabase(defaultDbPath());
    expect(createUserWorkspaceBindingsRepository(db).forOwner(userA.id).get()).toMatchObject({
      providerKind: "box",
      machineId: "machine-a2",
      createdAt: 1_000,
      updatedAt: 3_000,
    });
    expect(createComputerBindingsRepository(db).get("legacy-bot")?.boxId).toBe("legacy-machine");
  });

  it("does not disclose, overwrite, or delete another user's exact machine identity", () => {
    const [userA, userB] = users();
    const bindings = createUserWorkspaceBindingsRepository(db);
    const ownerA = bindings.forOwner(userA.id);
    const ownerB = bindings.forOwner(userB.id);
    ownerA.record("fake", "known-machine-a", 1_000);
    ownerB.record("box", "machine-b", 1_500);

    expect(ownerB.get()).toMatchObject({ providerKind: "box", machineId: "machine-b" });
    expect(ownerB.delete("fake", "known-machine-a")).toBe(false);
    expect(ownerA.get()).toMatchObject({ providerKind: "fake", machineId: "known-machine-a" });
    expect(ownerB.get()).toMatchObject({ providerKind: "box", machineId: "machine-b" });

    expect(() => ownerB.record("fake", "known-machine-a", 2_000)).toThrow(/UNIQUE/i);
    expect(ownerA.get()).toMatchObject({ providerKind: "fake", machineId: "known-machine-a", updatedAt: 1_000 });
    expect(ownerB.get()).toMatchObject({ providerKind: "box", machineId: "machine-b", updatedAt: 1_500 });
  });

  it("fails closed for malformed and nonexistent internal UUID owners", () => {
    const bindings = createUserWorkspaceBindingsRepository(db);
    expect(() => bindings.forOwner("not-a-uuid")).toThrow(/internal UUID/);

    const missing = bindings.forOwner(randomUUID());
    expect(missing.get()).toBeNull();
    expect(missing.delete("fake", "known-machine")).toBe(false);
    expect(() => missing.record("fake", "orphan-machine", 1_000)).toThrow(/FOREIGN KEY/i);
    expect(db.prepare<{ n: number }>("SELECT count(*) AS n FROM user_workspace_bindings").get()?.n).toBe(0);
  });

  it("enforces ownership and provider/machine uniqueness in SQLite", () => {
    const [userA, userB] = users();
    db.prepare(
      `INSERT INTO user_workspace_bindings(user_id, provider_kind, machine_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(userA.id, "fake", "machine-a", 1_000, 1_000);

    expect(() =>
      db.prepare(
        `INSERT INTO user_workspace_bindings(user_id, provider_kind, machine_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(userA.id, "box", "machine-a2", 2_000, 2_000),
    ).toThrow(/UNIQUE/i);
    expect(() =>
      db.prepare(
        `INSERT INTO user_workspace_bindings(user_id, provider_kind, machine_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(userB.id, "fake", "machine-a", 2_000, 2_000),
    ).toThrow(/UNIQUE/i);
    expect(() =>
      db.prepare(
        `INSERT INTO user_workspace_bindings(user_id, provider_kind, machine_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(randomUUID(), "fake", "orphan-machine", 2_000, 2_000),
    ).toThrow(/FOREIGN KEY/i);
    expect(db.prepare<{ n: number }>("SELECT count(*) AS n FROM user_workspace_bindings").get()?.n).toBe(1);
  });

  it("requires explicit binding deletion before user deletion and never reassigns the machine", () => {
    const [userA, userB] = users();
    const bindings = createUserWorkspaceBindingsRepository(db);
    const ownerA = bindings.forOwner(userA.id);
    ownerA.record("fake", "machine-a", 1_000);

    expect(() => db.prepare("DELETE FROM users WHERE id = ?").run(userA.id)).toThrow(/FOREIGN KEY/i);
    expect(bindings.forOwner(userB.id).get()).toBeNull();
    expect(ownerA.delete("fake", "wrong-machine")).toBe(false);
    expect(ownerA.delete("fake", "machine-a")).toBe(true);
    expect(ownerA.get()).toBeNull();
    expect(db.prepare("DELETE FROM users WHERE id = ?").run(userA.id).changes).toBe(1);
    expect(bindings.forOwner(userB.id).get()).toBeNull();
  });
});
