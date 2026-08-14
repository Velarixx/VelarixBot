// One factory: every repository over the same database handle, so
// cross-repo operations (bot delete → thread + messages + events + runs)
// can share transactions through SQLite itself.
import type { SqliteDatabase } from "../db/sqlite-native.ts";
import { createBotsRepository, type BotsRepository } from "./bots.ts";
import { createComputerBindingsRepository, type ComputerBindingsRepository } from "./computer-bindings.ts";
import { createEventLogRepository, type EventLogRepository } from "./event-log.ts";
import { createMessagesRepository, type MessagesRepository } from "./messages.ts";
import { createRoutinesRepository, type RoutinesRepository } from "./routines.ts";
import { createSnapshotsRepository, type SnapshotsRepository } from "./snapshots.ts";

export interface Repositories {
  db: SqliteDatabase;
  bots: BotsRepository;
  messages: MessagesRepository;
  routines: RoutinesRepository;
  eventLog: EventLogRepository;
  computerBindings: ComputerBindingsRepository;
  snapshots: SnapshotsRepository;
  /** Delete a bot and everything hanging off it in ONE transaction:
   * routines (+ run history), the thread (messages + event log), the
   * computer binding, and the bot row itself. */
  deleteBotCascade(botId: string): boolean;
}

export function createRepositories(db: SqliteDatabase): Repositories {
  const bots = createBotsRepository(db);
  const messages = createMessagesRepository(db);
  const routines = createRoutinesRepository(db);
  const eventLog = createEventLogRepository(db);
  const computerBindings = createComputerBindingsRepository(db);
  const snapshots = createSnapshotsRepository(db);
  const deleteBotRow = db.prepare("DELETE FROM bots WHERE id = ?");

  const deleteCascade = db.transaction((botId: string): { deleted: boolean; hashes: string[] } => {
    const bot = bots.get(botId);
    if (!bot) return { deleted: false, hashes: [] };
    routines.deleteForBot(botId);
    computerBindings.delete(botId);
    deleteBotRow.run(botId);
    const hashes = messages.deleteThreadRows(bot.threadId);
    return { deleted: true, hashes };
  });

  return {
    db,
    bots,
    messages,
    routines,
    eventLog,
    computerBindings,
    snapshots,
    deleteBotCascade(botId) {
      const { deleted, hashes } = deleteCascade(botId);
      if (deleted) messages.gcBlobHashes(hashes);
      return deleted;
    },
  };
}
