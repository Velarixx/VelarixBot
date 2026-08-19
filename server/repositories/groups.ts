// Bot⇄bot DM rows. One SQLite row per group (record JSON in `data`).
// Threads are created on first message append (messages.ensureThread).
import type { SqliteDatabase } from "../db/sqlite-native.ts";
import { normalizeGroup, type GroupRecord } from "../store.ts";

interface GroupRow {
  id: string;
  thread_id: string;
  created_at: number;
  data: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function assertOwnerId(ownerId: string): void {
  if (!UUID_PATTERN.test(ownerId)) throw new TypeError("ownerId must be an internal UUID");
}

function toRecord(row: GroupRow): GroupRecord | null {
  try {
    return normalizeGroup(JSON.parse(row.data));
  } catch {
    return null;
  }
}

export interface GroupsRepository {
  /** Legacy desktop access. These methods intentionally include unowned and
   * tenant-owned rows and must never be used as a tenant security boundary. */
  list(): GroupRecord[];
  get(id: string): GroupRecord | null;
  getByThread(threadId: string): GroupRecord | null;
  insert(group: GroupRecord): void;
  update(group: GroupRecord): boolean;
  /** Bind every operation to one internal user UUID. The returned interface
   * has no unscoped escape hatch and excludes legacy owner_id=NULL rows. */
  forOwner(ownerId: string): TenantGroupsRepository;
}

export interface TenantGroupsRepository {
  list(): GroupRecord[];
  get(id: string): GroupRecord | null;
  getByThread(threadId: string): GroupRecord | null;
  insert(group: GroupRecord): void;
  update(group: GroupRecord): boolean;
}

export function createGroupsRepository(db: SqliteDatabase): GroupsRepository {
  const insertOwnedThread = db.prepare(
    "INSERT INTO threads(id, bot_id, created_at, owner_id) VALUES (?, NULL, ?, ?)",
  );
  const insertGroup = db.prepare("INSERT INTO groups(id, thread_id, created_at, data) VALUES (?, ?, ?, ?)");
  const insertOwnedGroup = db.prepare(
    "INSERT INTO groups(id, thread_id, created_at, data, owner_id) VALUES (?, ?, ?, ?, ?)",
  );
  const updateGroup = db.prepare("UPDATE groups SET data = ? WHERE id = ?");
  const selectAll = db.prepare<GroupRow>("SELECT id, thread_id, created_at, data FROM groups ORDER BY seq DESC");
  const selectById = db.prepare<GroupRow>("SELECT id, thread_id, created_at, data FROM groups WHERE id = ?");
  const selectByThread = db.prepare<GroupRow>("SELECT id, thread_id, created_at, data FROM groups WHERE thread_id = ?");
  const selectAllForOwner = db.prepare<GroupRow>(
    "SELECT id, thread_id, created_at, data FROM groups WHERE owner_id = ? ORDER BY seq DESC",
  );
  const selectByIdForOwner = db.prepare<GroupRow>(
    "SELECT id, thread_id, created_at, data FROM groups WHERE owner_id = ? AND id = ?",
  );
  const selectByThreadForOwner = db.prepare<GroupRow>(
    "SELECT id, thread_id, created_at, data FROM groups WHERE owner_id = ? AND thread_id = ?",
  );
  const updateForOwner = db.prepare(
    "UPDATE groups SET data = ? WHERE owner_id = ? AND id = ? AND thread_id = ?",
  );

  const insertOwnedTx = db.transaction((ownerId: string, group: GroupRecord) => {
    insertOwnedThread.run(group.threadId, group.createdAt, ownerId);
    insertOwnedGroup.run(group.id, group.threadId, group.createdAt, JSON.stringify(group), ownerId);
  });

  function forOwner(ownerId: string): TenantGroupsRepository {
    assertOwnerId(ownerId);
    return {
      list() {
        return selectAllForOwner.all(ownerId).map(toRecord).filter((group): group is GroupRecord => !!group);
      },
      get(id) {
        const row = selectByIdForOwner.get(ownerId, id);
        return row ? toRecord(row) : null;
      },
      getByThread(threadId) {
        const row = selectByThreadForOwner.get(ownerId, threadId);
        return row ? toRecord(row) : null;
      },
      insert(group) {
        insertOwnedTx(ownerId, group);
      },
      update(group) {
        return updateForOwner.run(JSON.stringify(group), ownerId, group.id, group.threadId).changes > 0;
      },
    };
  }

  return {
    list() {
      return selectAll.all().map(toRecord).filter((g): g is GroupRecord => !!g);
    },
    get(id) {
      const row = selectById.get(id);
      return row ? toRecord(row) : null;
    },
    getByThread(threadId) {
      const row = selectByThread.get(threadId);
      return row ? toRecord(row) : null;
    },
    insert(group) {
      insertGroup.run(group.id, group.threadId, group.createdAt, JSON.stringify(group));
    },
    update(group) {
      return updateGroup.run(JSON.stringify(group), group.id).changes > 0;
    },
    forOwner,
  };
}
