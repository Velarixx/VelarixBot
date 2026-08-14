// Which remote computer (machine id) a bot is bound to. A cache of the
// provider-side lookup (the ComputerProvider stays authoritative — a vendor
// can archive or recycle a machine at any time); recorded when a machine is
// found or provisioned, dropped with the bot. Column names keep the
// original box_* spelling — a rename would churn the schema for nothing.
import type { SqliteDatabase } from "../db/sqlite-native.ts";

export interface ComputerBinding {
  botId: string;
  boxId: string;
  createdAt: number;
  updatedAt: number;
}

interface BindingRow {
  bot_id: string;
  box_id: string;
  created_at: number;
  updated_at: number;
}

export interface ComputerBindingsRepository {
  get(botId: string): ComputerBinding | null;
  record(botId: string, boxId: string, now?: number): void;
  delete(botId: string): boolean;
  list(): ComputerBinding[];
}

export function createComputerBindingsRepository(db: SqliteDatabase): ComputerBindingsRepository {
  const upsert = db.prepare(
    `INSERT INTO computer_bindings(bot_id, box_id, created_at, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(bot_id) DO UPDATE SET box_id = excluded.box_id, updated_at = excluded.updated_at`,
  );
  const selectOne = db.prepare<BindingRow>("SELECT bot_id, box_id, created_at, updated_at FROM computer_bindings WHERE bot_id = ?");
  const selectAll = db.prepare<BindingRow>("SELECT bot_id, box_id, created_at, updated_at FROM computer_bindings ORDER BY bot_id");
  const remove = db.prepare("DELETE FROM computer_bindings WHERE bot_id = ?");

  const toBinding = (row: BindingRow): ComputerBinding => ({
    botId: row.bot_id,
    boxId: row.box_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });

  return {
    get(botId) {
      const row = selectOne.get(botId);
      return row ? toBinding(row) : null;
    },
    record(botId, boxId, now = Date.now()) {
      upsert.run(botId, boxId, now, now);
    },
    delete(botId) {
      return remove.run(botId).changes > 0;
    },
    list() {
      return selectAll.all().map(toBinding);
    },
  };
}
