// Durable idempotency keys for the P6 lane scheduler. One key maps to
// one work id: a retried inbound or routine fire cannot start a second
// turn. The live queue is in-memory; this table is the restart-safe
// dedupe, sitting beside (not replacing) routine_runs claims.
import type { SqliteDatabase } from "../db/sqlite-native.ts";

export const SCHEDULER_LANES = ["user", "channel", "agent", "background"] as const;
export type SchedulerLane = (typeof SCHEDULER_LANES)[number];

export const LANE_KEY_STATUSES = ["queued", "running", "cancelled", "done"] as const;
export type LaneKeyStatus = (typeof LANE_KEY_STATUSES)[number];

export interface LaneIdempotencyRow {
  key: string;
  workId: string;
  lane: SchedulerLane;
  botId: string;
  createdAt: number;
  status: LaneKeyStatus;
}

export interface ClaimLaneKeyInput {
  key: string;
  workId: string;
  lane: SchedulerLane;
  botId: string;
  createdAt: number;
}

function isLane(value: string): value is SchedulerLane {
  return (SCHEDULER_LANES as readonly string[]).includes(value);
}

function isStatus(value: string): value is LaneKeyStatus {
  return (LANE_KEY_STATUSES as readonly string[]).includes(value);
}

function toRow(row: {
  key: string;
  work_id: string;
  lane: string;
  bot_id: string;
  created_at: number;
  status: string;
}): LaneIdempotencyRow | null {
  if (!isLane(row.lane) || !isStatus(row.status)) return null;
  return {
    key: row.key,
    workId: row.work_id,
    lane: row.lane,
    botId: row.bot_id,
    createdAt: row.created_at,
    status: row.status,
  };
}

export interface LaneIdempotencyRepository {
  /** Insert the key. Returns the existing row when the key is already held. */
  claim(input: ClaimLaneKeyInput): { row: LaneIdempotencyRow; created: boolean };
  get(key: string): LaneIdempotencyRow | null;
  setStatus(key: string, status: LaneKeyStatus): boolean;
  listForBot(botId: string): LaneIdempotencyRow[];
  deleteForBot(botId: string): void;
}

export function createLaneIdempotencyRepository(db: SqliteDatabase): LaneIdempotencyRepository {
  const select = db.prepare<{
    key: string;
    work_id: string;
    lane: string;
    bot_id: string;
    created_at: number;
    status: string;
  }>("SELECT key, work_id, lane, bot_id, created_at, status FROM lane_idempotency WHERE key = ?");
  const selectBot = db.prepare<{
    key: string;
    work_id: string;
    lane: string;
    bot_id: string;
    created_at: number;
    status: string;
  }>("SELECT key, work_id, lane, bot_id, created_at, status FROM lane_idempotency WHERE bot_id = ? ORDER BY created_at, key");
  const insert = db.prepare(
    "INSERT INTO lane_idempotency(key, work_id, lane, bot_id, created_at, status) VALUES (?, ?, ?, ?, ?, 'queued')",
  );
  const updateStatus = db.prepare("UPDATE lane_idempotency SET status = ? WHERE key = ?");
  const deleteBot = db.prepare("DELETE FROM lane_idempotency WHERE bot_id = ?");

  return {
    claim(input) {
      const key = String(input.key ?? "").trim();
      if (!key || key.length > 512) throw new Error("lane idempotency key required");
      const existing = select.get(key);
      if (existing) {
        const row = toRow(existing);
        if (!row) throw new Error("lane idempotency row is corrupt");
        return { row, created: false };
      }
      try {
        insert.run(key, input.workId, input.lane, input.botId, input.createdAt);
      } catch (error) {
        const raced = select.get(key);
        if (raced) {
          const row = toRow(raced);
          if (!row) throw new Error("lane idempotency row is corrupt");
          return { row, created: false };
        }
        throw error;
      }
      const created = select.get(key);
      const row = created ? toRow(created) : null;
      if (!row) throw new Error("lane idempotency insert failed");
      return { row, created: true };
    },
    get(key) {
      const raw = select.get(String(key ?? "").trim());
      return raw ? toRow(raw) : null;
    },
    setStatus(key, status) {
      return updateStatus.run(status, String(key ?? "").trim()).changes > 0;
    },
    listForBot(botId) {
      return selectBot.all(botId).map(toRow).filter((row): row is LaneIdempotencyRow => row !== null);
    },
    deleteForBot(botId) {
      deleteBot.run(botId);
    },
  };
}
