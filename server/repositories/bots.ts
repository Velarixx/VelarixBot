// Bot rows: one SQLite row per bot (record JSON in `data`, keys mirrored to
// columns for lookups), one thread row per bot. Ordering follows the old
// unshift semantics: newest bot first.
import type { SqliteDatabase } from "../db/sqlite-native.ts";
import {
  generatePublicBotHandle,
  isPublicBotHandle,
  PUBLIC_BOT_HANDLE_GENERATION_ATTEMPTS,
} from "../public-bot-handle.ts";
import { normalizeBot, type BotRecord } from "../store.ts";

interface BotRow {
  id: string;
  thread_id: string;
  created_at: number;
  data: string;
}

interface TenantBotRow extends BotRow {
  public_handle: string;
}

export type TenantBotRecord = BotRecord & { publicHandle: string };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function assertOwnerId(ownerId: string): void {
  if (!UUID_PATTERN.test(ownerId)) throw new TypeError("ownerId must be an internal UUID");
}

function toRecord(row: BotRow): BotRecord | null {
  try {
    return normalizeBot(JSON.parse(row.data));
  } catch {
    return null;
  }
}

export interface BotsRepository {
  /** Legacy desktop access. These methods intentionally include unowned and
   * tenant-owned rows and must never be used as a tenant security boundary. */
  list(): BotRecord[];
  get(id: string): BotRecord | null;
  getByThread(threadId: string): BotRecord | null;
  count(): number;
  insert(bot: BotRecord): void;
  update(bot: BotRecord): boolean;
  /** Boot-time crash recovery: a bot that died mid-turn reloads as
   * BLOCKED/interrupted, never as a phantom RUNNING. */
  recoverInterrupted(): number;

  /** Bind every operation to one internal user UUID. The returned interface
   * has no unscoped escape hatch and excludes legacy owner_id=NULL rows. */
  forOwner(ownerId: string): TenantBotsRepository;
}

function serializeRecord(bot: BotRecord): string {
  // The public handle is a relational routing key, not part of the mutable
  // desktop-compatible JSON document.
  const { publicHandle: _publicHandle, ...data } = bot as BotRecord & { publicHandle?: string };
  return JSON.stringify(data);
}

function toTenantRecord(row: TenantBotRow): TenantBotRecord | null {
  const bot = toRecord(row);
  return bot && isPublicBotHandle(row.public_handle)
    ? { ...bot, publicHandle: row.public_handle }
    : null;
}

export interface TenantBotsRepository {
  list(): TenantBotRecord[];
  get(id: string): TenantBotRecord | null;
  getByThread(threadId: string): TenantBotRecord | null;
  /** A public handle is only useful inside this already owner-bound facade. */
  getByPublicHandle(publicHandle: string): TenantBotRecord | null;
  count(): number;
  insert(bot: BotRecord): TenantBotRecord;
  update(bot: BotRecord): boolean;
}

export function createBotsRepository(
  db: SqliteDatabase,
  opts: { generatePublicHandle?: () => string } = {},
): BotsRepository {
  const createHandle = opts.generatePublicHandle ?? generatePublicBotHandle;
  const insertThread = db.prepare("INSERT INTO threads(id, bot_id, created_at) VALUES (?, ?, ?)");
  const insertOwnedThread = db.prepare(
    "INSERT INTO threads(id, bot_id, created_at, owner_id) VALUES (?, ?, ?, ?)",
  );
  const insertBot = db.prepare("INSERT INTO bots(id, thread_id, created_at, data) VALUES (?, ?, ?, ?)");
  const updateBot = db.prepare("UPDATE bots SET data = ? WHERE id = ?");
  const selectAll = db.prepare<BotRow>("SELECT id, thread_id, created_at, data FROM bots ORDER BY seq DESC");
  const selectById = db.prepare<BotRow>("SELECT id, thread_id, created_at, data FROM bots WHERE id = ?");
  const selectByThread = db.prepare<BotRow>("SELECT id, thread_id, created_at, data FROM bots WHERE thread_id = ?");
  const countStmt = db.prepare<{ n: number }>("SELECT count(*) AS n FROM bots");
  const selectAllForOwner = db.prepare<TenantBotRow>(
    "SELECT id, thread_id, created_at, data, public_handle FROM bots WHERE owner_id = ? ORDER BY seq DESC",
  );
  const selectByIdForOwner = db.prepare<TenantBotRow>(
    "SELECT id, thread_id, created_at, data, public_handle FROM bots WHERE owner_id = ? AND id = ?",
  );
  const selectByThreadForOwner = db.prepare<TenantBotRow>(
    "SELECT id, thread_id, created_at, data, public_handle FROM bots WHERE owner_id = ? AND thread_id = ?",
  );
  const selectByPublicHandleForOwner = db.prepare<TenantBotRow>(
    "SELECT id, thread_id, created_at, data, public_handle FROM bots WHERE owner_id = ? AND public_handle = ?",
  );
  const countForOwner = db.prepare<{ n: number }>("SELECT count(*) AS n FROM bots WHERE owner_id = ?");
  const insertOwnedBot = db.prepare(
    "INSERT INTO bots(id, thread_id, created_at, data, owner_id, public_handle) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const reservePublicHandle = db.prepare(
    "INSERT INTO public_bot_handles(handle, bot_id, created_at) VALUES (?, ?, ?)",
  );
  const selectPublicHandleReservation = db.prepare("SELECT 1 FROM public_bot_handles WHERE handle = ?");
  const updateOwnedBot = db.prepare(
    "UPDATE bots SET data = ? WHERE owner_id = ? AND id = ? AND thread_id = ?",
  );

  const insertTx = db.transaction((bot: BotRecord) => {
    insertThread.run(bot.threadId, bot.id, bot.createdAt);
    insertBot.run(bot.id, bot.threadId, bot.createdAt, serializeRecord(bot));
  });

  const insertOwnedTx = db.transaction((ownerId: string, bot: BotRecord): TenantBotRecord => {
    insertOwnedThread.run(bot.threadId, bot.id, bot.createdAt, ownerId);
    let publicHandle: string | null = null;
    for (let attempt = 0; attempt < PUBLIC_BOT_HANDLE_GENERATION_ATTEMPTS; attempt++) {
      const candidate = createHandle();
      if (!isPublicBotHandle(candidate)) throw new Error("public bot handle generator returned an invalid handle");
      if (!selectPublicHandleReservation.get(candidate)) {
        publicHandle = candidate;
        break;
      }
    }
    if (!publicHandle) throw new Error("could not reserve a unique public bot handle");
    reservePublicHandle.run(publicHandle, bot.id, bot.createdAt);
    insertOwnedBot.run(bot.id, bot.threadId, bot.createdAt, serializeRecord(bot), ownerId, publicHandle);
    return { ...bot, publicHandle };
  });

  function forOwner(ownerId: string): TenantBotsRepository {
    assertOwnerId(ownerId);
    return {
      list() {
        return selectAllForOwner.all(ownerId).map(toTenantRecord).filter((bot): bot is TenantBotRecord => !!bot);
      },
      get(id) {
        const row = selectByIdForOwner.get(ownerId, id);
        return row ? toTenantRecord(row) : null;
      },
      getByThread(threadId) {
        const row = selectByThreadForOwner.get(ownerId, threadId);
        return row ? toTenantRecord(row) : null;
      },
      getByPublicHandle(publicHandle) {
        if (!isPublicBotHandle(publicHandle)) return null;
        const row = selectByPublicHandleForOwner.get(ownerId, publicHandle);
        return row ? toTenantRecord(row) : null;
      },
      count() {
        return countForOwner.get(ownerId)?.n ?? 0;
      },
      insert(bot) {
        return insertOwnedTx(ownerId, bot);
      },
      update(bot) {
        return updateOwnedBot.run(serializeRecord(bot), ownerId, bot.id, bot.threadId).changes > 0;
      },
    };
  }

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
      return updateBot.run(serializeRecord(bot), bot.id).changes > 0;
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
    forOwner,
  };
}
