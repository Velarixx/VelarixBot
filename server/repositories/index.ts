// One factory: every repository over the same database handle, so
// cross-repo operations (bot delete → thread + messages + events + runs)
// can share transactions through SQLite itself.
import { collectAvatarHashes } from "../avatar-image.ts";
import type { SqliteDatabase } from "../db/sqlite-native.ts";
import { createBotsRepository, type BotsRepository } from "./bots.ts";
import { createComputerBindingsRepository, type ComputerBindingsRepository } from "./computer-bindings.ts";
import { createEventLogRepository, type EventLogRepository } from "./event-log.ts";
import { createGroupsRepository, type GroupsRepository } from "./groups.ts";
import { createMessagesRepository, type MessagesRepository } from "./messages.ts";
import { createMemoryRowsRepository } from "./memory-rows.ts";
import { createRoutinesRepository, type RoutinesRepository } from "./routines.ts";
import { createSnapshotsRepository, type SnapshotsRepository } from "./snapshots.ts";
import {
  createUserWorkspaceBindingsRepository,
  type UserWorkspaceBindingsRepository,
} from "./user-workspace-bindings.ts";
import type { MemoryRowsStore } from "../memory.ts";

export interface Repositories {
  db: SqliteDatabase;
  bots: BotsRepository;
  messages: MessagesRepository;
  groups: GroupsRepository;
  routines: RoutinesRepository;
  eventLog: EventLogRepository;
  computerBindings: ComputerBindingsRepository;
  userWorkspaceBindings: UserWorkspaceBindingsRepository;
  snapshots: SnapshotsRepository;
  memoryRows: MemoryRowsStore;
  /** Delete a bot and everything hanging off it in ONE transaction:
   * routines (+ run history), the thread (messages + event log), the
   * computer binding, structured memory rows, and the bot row itself. */
  deleteBotCascade(botId: string): boolean;
}

export function createRepositories(db: SqliteDatabase): Repositories {
  const bots = createBotsRepository(db);
  const messages = createMessagesRepository(db, {
    extraReferencedBlobs: () => collectAvatarHashes(bots.list()),
  });
  const groups = createGroupsRepository(db);
  const routines = createRoutinesRepository(db);
  const eventLog = createEventLogRepository(db);
  const computerBindings = createComputerBindingsRepository(db);
  const userWorkspaceBindings = createUserWorkspaceBindingsRepository(db);
  const snapshots = createSnapshotsRepository(db);
  const memoryRows = createMemoryRowsRepository(db);
  const deleteBotRow = db.prepare("DELETE FROM bots WHERE id = ?");

  const deleteCascade = db.transaction((botId: string): { deleted: boolean; hashes: string[] } => {
    const bot = bots.get(botId);
    if (!bot) return { deleted: false, hashes: [] };
    routines.deleteForBot(botId);
    computerBindings.delete(botId);
    memoryRows.deleteByBot(botId);
    deleteBotRow.run(botId);
    const hashes = messages.deleteThreadRows(bot.threadId);
    return { deleted: true, hashes };
  });

  return {
    db,
    bots,
    messages,
    groups,
    routines,
    eventLog,
    computerBindings,
    userWorkspaceBindings,
    snapshots,
    memoryRows,
    deleteBotCascade(botId) {
      const dying = collectAvatarHashes(bots.get(botId) ? [bots.get(botId)!] : []);
      const { deleted, hashes } = deleteCascade(botId);
      if (deleted) messages.gcBlobHashes([...hashes, ...dying]);
      return deleted;
    },
  };
}
