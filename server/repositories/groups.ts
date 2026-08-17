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

function toRecord(row: GroupRow): GroupRecord | null {
  try {
    return normalizeGroup(JSON.parse(row.data));
  } catch {
    return null;
  }
}

export interface GroupsRepository {
  list(): GroupRecord[];
  get(id: string): GroupRecord | null;
  getByThread(threadId: string): GroupRecord | null;
  insert(group: GroupRecord): void;
  update(group: GroupRecord): boolean;
}

export function createGroupsRepository(db: SqliteDatabase): GroupsRepository {
  const insertGroup = db.prepare("INSERT INTO groups(id, thread_id, created_at, data) VALUES (?, ?, ?, ?)");
  const updateGroup = db.prepare("UPDATE groups SET data = ? WHERE id = ?");
  const selectAll = db.prepare<GroupRow>("SELECT id, thread_id, created_at, data FROM groups ORDER BY seq DESC");
  const selectById = db.prepare<GroupRow>("SELECT id, thread_id, created_at, data FROM groups WHERE id = ?");
  const selectByThread = db.prepare<GroupRow>("SELECT id, thread_id, created_at, data FROM groups WHERE thread_id = ?");

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
  };
}
