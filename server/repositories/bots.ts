// Bot rows: one SQLite row per bot (record JSON in `data`, keys mirrored to
// columns for lookups), one thread row per bot. Ordering follows the old
// unshift semantics: newest bot first.
import type { SqliteDatabase } from "../db/sqlite-native.ts";
import { normalizeBot, type BotRecord } from "../store.ts";

interface BotRow {
  id: string;
  thread_id: string;
  created_at: number;
  data: string;
}

function toRecord(row: BotRow): BotRecord | null {
  try {
    return normalizeBot(JSON.parse(row.data));
  } catch {
    return null;
  }
}

export interface BotsRepository {
  list(): BotRecord[];
  get(id: string): BotRecord | null;
  getByThread(threadId: string): BotRecord | null;
  count(): number;
  insert(bot: BotRecord): void;
  update(bot: BotRecord): boolean;
  /** Boot-time crash recovery: a bot that died mid-turn reloads as
   * BLOCKED/interrupted, never as a phantom RUNNING. */
  recoverInterrupted(): number;
}

export function createBotsRepository(db: SqliteDatabase): BotsRepository {
  const insertThread = db.prepare("INSERT INTO threads(id, bot_id, created_at) VALUES (?, ?, ?)");
  const insertBot = db.prepare("INSERT INTO bots(id, thread_id, created_at, data) VALUES (?, ?, ?, ?)");
  const updateBot = db.prepare("UPDATE bots SET data = ? WHERE id = ?");
  const selectAll = db.prepare<BotRow>("SELECT id, thread_id, created_at, data FROM bots ORDER BY seq DESC");
  const selectById = db.prepare<BotRow>("SELECT id, thread_id, created_at, data FROM bots WHERE id = ?");
  const selectByThread = db.prepare<BotRow>("SELECT id, thread_id, created_at, data FROM bots WHERE thread_id = ?");
  const countStmt = db.prepare<{ n: number }>("SELECT count(*) AS n FROM bots");

  const insertTx = db.transaction((bot: BotRecord) => {
    insertThread.run(bot.threadId, bot.id, bot.createdAt);
    insertBot.run(bot.id, bot.threadId, bot.createdAt, JSON.stringify(bot));
  });

  return {
    list() {
      return selectAll.all().map(toRecord).filter((b): b is BotRecord => !!b);
    },
    get(id) {
      const row = selectById.get(id);
      return row ? toRecord(row) : null;
    },
    getByThread(threadId) {
      const row = selectByThread.get(threadId);
      return row ? toRecord(row) : null;
    },
    count() {
      return countStmt.get()?.n ?? 0;
    },
    insert(bot) {
      insertTx(bot);
    },
    update(bot) {
      return updateBot.run(JSON.stringify(bot), bot.id).changes > 0;
    },
    recoverInterrupted() {
      let recovered = 0;
      const tx = db.transaction(() => {
        for (const row of selectAll.all()) {
          let raw: unknown;
          try {
            raw = JSON.parse(row.data);
          } catch {
            continue;
          }
          const before = normalizeBot(raw);
          const after = normalizeBot(raw, { recoverInterrupted: true });
          if (!before || !after) continue;
          if (before.busy === after.busy && before.state === after.state) continue;
          updateBot.run(JSON.stringify(after), row.id);
          recovered++;
        }
      });
      tx();
      return recovered;
    },
  };
}
