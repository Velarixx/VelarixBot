// Structured memory rows (MEM v1). Additive to ~/.velarixbot/memory/*.md.
// The v1 `memory(owner, user_text, distilled_text)` table is left untouched
// as the markdown export snapshot — this table is the only SQLite home for
// typed rows. Runtime inject/recall go through memory.ts composition.
import { newId } from "../contracts.ts";
import type { MemoryRow, MemoryRowType, MemoryRowsStore } from "../memory.ts";
import { isMemoryRowType } from "../memory.ts";
import type { SqliteDatabase } from "../db/sqlite-native.ts";

interface Row {
  id: string;
  bot_id: string;
  type: string;
  text: string;
  pinned: number;
  use_count: number;
  created_at: number;
  updated_at: number;
}

function toRow(row: Row): MemoryRow {
  return {
    id: row.id,
    botId: row.bot_id,
    type: row.type as MemoryRowType,
    text: row.text,
    pinned: row.pinned === 1,
    useCount: row.use_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createMemoryRowsRepository(db: SqliteDatabase): MemoryRowsStore {
  const insert = db.prepare(
    "INSERT INTO memory_rows(id, bot_id, type, text, pinned, use_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const selectOne = db.prepare<Row>("SELECT id, bot_id, type, text, pinned, use_count, created_at, updated_at FROM memory_rows WHERE id = ?");
  const selectBot = db.prepare<Row>(
    "SELECT id, bot_id, type, text, pinned, use_count, created_at, updated_at FROM memory_rows WHERE bot_id = ? ORDER BY pinned DESC, updated_at DESC, id",
  );
  const updateSql = db.prepare(
    "UPDATE memory_rows SET type = ?, text = ?, pinned = ?, use_count = ?, updated_at = ? WHERE id = ?",
  );
  const remove = db.prepare("DELETE FROM memory_rows WHERE id = ?");
  const removeBot = db.prepare("DELETE FROM memory_rows WHERE bot_id = ?");

  return {
    insert(input) {
      if (!isMemoryRowType(input.type)) throw new Error("invalid memory row type");
      const text = input.text.trim();
      if (!text) throw new Error("memory row text required");
      const now = input.createdAt ?? Date.now();
      const row: MemoryRow = {
        id: input.id ?? newId(),
        botId: input.botId,
        type: input.type,
        text,
        pinned: input.pinned === true,
        useCount: input.useCount ?? 0,
        createdAt: now,
        updatedAt: input.updatedAt ?? now,
      };
      insert.run(row.id, row.botId, row.type, row.text, row.pinned ? 1 : 0, row.useCount, row.createdAt, row.updatedAt);
      return row;
    },
    get(id) {
      const row = selectOne.get(id);
      return row ? toRow(row) : null;
    },
    listByBot(botId) {
      return selectBot.all(botId).map(toRow);
    },
    update(id, patch) {
      const existing = selectOne.get(id);
      if (!existing) return null;
      const next = toRow(existing);
      if (patch.type !== undefined) {
        if (!isMemoryRowType(patch.type)) throw new Error("invalid memory row type");
        next.type = patch.type;
      }
      if (patch.text !== undefined) {
        const text = patch.text.trim();
        if (!text) throw new Error("memory row text required");
        next.text = text;
      }
      if (patch.pinned !== undefined) next.pinned = patch.pinned;
      if (patch.useCount !== undefined) next.useCount = patch.useCount;
      next.updatedAt = patch.updatedAt ?? Date.now();
      updateSql.run(next.type, next.text, next.pinned ? 1 : 0, next.useCount, next.updatedAt, id);
      return next;
    },
    delete(id) {
      return remove.run(id).changes > 0;
    },
    deleteByBot(botId) {
      return removeBot.run(botId).changes;
    },
  };
}
