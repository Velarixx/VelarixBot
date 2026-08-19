import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "../config.ts";
import { defaultDbPath, openDatabase } from "../db/database.ts";
import type { SqliteDatabase } from "../db/sqlite-native.ts";
import { IdentitySessions } from "../identity.ts";
import type { GroupRecord } from "../store.ts";
import { createGroupsRepository } from "./groups.ts";

function makeGroup(overrides: Partial<GroupRecord> = {}): GroupRecord {
  const id = overrides.id ?? `group-${Math.random().toString(36).slice(2)}`;
  return {
    id,
    threadId: overrides.threadId ?? `thread-${id}`,
    name: "Test group",
    memberIds: ["bot-a", "bot-b"],
    unread: false,
    createdAt: Date.now(),
    ...overrides,
  };
}

describe("groups repository", () => {
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

  it("isolates owner-bound lookup and update from other owners and legacy rows", () => {
    const identity = new IdentitySessions(db);
    const userA = identity.upsertGithubIdentity({ githubId: 101, login: "tenant-a" }, 1_000);
    const userB = identity.upsertGithubIdentity({ githubId: 202, login: "tenant-b" }, 1_000);
    const groups = createGroupsRepository(db);
    const legacy = makeGroup({ name: "Legacy", createdAt: 1_000 });
    const groupA = makeGroup({ name: "A", createdAt: 2_000 });
    const groupB = makeGroup({ name: "B", createdAt: 3_000 });

    groups.insert(legacy);
    groups.forOwner(userA.id).insert(groupA);
    groups.forOwner(userB.id).insert(groupB);

    expect(() => groups.forOwner("not-a-uuid")).toThrow(/internal UUID/);
    expect(groups.forOwner(userA.id).list().map((group) => group.id)).toEqual([groupA.id]);
    expect(groups.forOwner(userA.id).get(groupA.id)?.name).toBe("A");
    expect(groups.forOwner(userA.id).get(groupB.id)).toBeNull();
    expect(groups.forOwner(userA.id).get(legacy.id)).toBeNull();
    expect(groups.forOwner(userA.id).getByThread(groupA.threadId)?.id).toBe(groupA.id);
    expect(groups.forOwner(userA.id).getByThread(groupB.threadId)).toBeNull();

    expect(groups.forOwner(userA.id).update({ ...groupB, name: "stolen" })).toBe(false);
    expect(groups.forOwner(userA.id).update({ ...legacy, name: "claimed" })).toBe(false);
    expect(groups.forOwner(userA.id).update({ ...groupA, threadId: groupB.threadId, name: "swapped" })).toBe(false);
    expect(groups.forOwner(userA.id).update({ ...groupA, name: "renamed" })).toBe(true);
    expect(groups.get(groupA.id)?.name).toBe("renamed");
    expect(groups.get(groupB.id)?.name).toBe("B");
    expect(groups.get(legacy.id)?.name).toBe("Legacy");
  });

  it("creates group and same-owner thread atomically and rejects invalid owners", () => {
    const identity = new IdentitySessions(db);
    const user = identity.upsertGithubIdentity({ githubId: 303, login: "owner" }, 1_000);
    const groups = createGroupsRepository(db);
    const owned = makeGroup();

    groups.forOwner(user.id).insert(owned);
    expect(
      db.prepare<{ owner_id: string | null; bot_id: string | null }>(
        "SELECT owner_id, bot_id FROM threads WHERE id = ?",
      ).get(owned.threadId),
    ).toEqual({ owner_id: user.id, bot_id: null });
    expect(db.prepare<{ owner_id: string | null }>("SELECT owner_id FROM groups WHERE id = ?").get(owned.id)).toEqual({
      owner_id: user.id,
    });

    const missingOwner = makeGroup();
    expect(() => groups.forOwner(randomUUID()).insert(missingOwner)).toThrow(/FOREIGN KEY/i);
    expect(groups.get(missingOwner.id)).toBeNull();
    expect(db.prepare("SELECT 1 FROM threads WHERE id = ?").get(missingOwner.threadId)).toBeUndefined();
  });

  it("rolls back the owned thread when a group or thread id collides", () => {
    const identity = new IdentitySessions(db);
    const user = identity.upsertGithubIdentity({ githubId: 404, login: "collision-owner" }, 1_000);
    const groups = createGroupsRepository(db);
    const existing = makeGroup();
    groups.forOwner(user.id).insert(existing);

    const groupCollision = makeGroup({ id: existing.id, threadId: "fresh-group-thread" });
    expect(() => groups.forOwner(user.id).insert(groupCollision)).toThrow(/UNIQUE/i);
    expect(db.prepare("SELECT 1 FROM threads WHERE id = ?").get(groupCollision.threadId)).toBeUndefined();

    const threadCollision = makeGroup({ id: "fresh-group", threadId: existing.threadId });
    expect(() => groups.forOwner(user.id).insert(threadCollision)).toThrow(/UNIQUE/i);
    expect(groups.get(threadCollision.id)).toBeNull();
    expect(db.prepare<{ n: number }>("SELECT count(*) AS n FROM groups").get()?.n).toBe(1);
    expect(db.prepare<{ n: number }>("SELECT count(*) AS n FROM threads").get()?.n).toBe(1);
  });
});
