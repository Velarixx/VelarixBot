// Telegram chat_id → VelarixBot conversation (bot + thread). One row per
// Telegram chat so inbound messages and outbound replies stay paired.
import type { SqliteDatabase } from "../db/sqlite-native.ts";

export interface TelegramConversation {
  chatId: string;
  userId: string | null;
  botId: string;
  threadId: string;
  createdAt: number;
  updatedAt: number;
}

interface ConversationRow {
  chat_id: string;
  user_id: string | null;
  bot_id: string;
  thread_id: string;
  created_at: number;
  updated_at: number;
}

function toConversation(row: ConversationRow): TelegramConversation {
  return {
    chatId: row.chat_id,
    userId: row.user_id,
    botId: row.bot_id,
    threadId: row.thread_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface TelegramConversationsRepository {
  upsert(row: {
    chatId: string;
    userId?: string | null;
    botId: string;
    threadId: string;
    now: number;
  }): TelegramConversation;
  getByChat(chatId: string): TelegramConversation | null;
  listByBot(botId: string): TelegramConversation[];
  listByThread(threadId: string): TelegramConversation[];
  deleteForBot(botId: string): void;
  deleteByChat(chatId: string): void;
}

export function createTelegramConversationsRepository(db: SqliteDatabase): TelegramConversationsRepository {
  const selectChat = db.prepare<ConversationRow>(
    "SELECT chat_id, user_id, bot_id, thread_id, created_at, updated_at FROM telegram_conversations WHERE chat_id = ?",
  );
  const selectBot = db.prepare<ConversationRow>(
    "SELECT chat_id, user_id, bot_id, thread_id, created_at, updated_at FROM telegram_conversations WHERE bot_id = ? ORDER BY updated_at, chat_id",
  );
  const selectThread = db.prepare<ConversationRow>(
    "SELECT chat_id, user_id, bot_id, thread_id, created_at, updated_at FROM telegram_conversations WHERE thread_id = ? ORDER BY updated_at, chat_id",
  );
  const insert = db.prepare(
    "INSERT INTO telegram_conversations(chat_id, user_id, bot_id, thread_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const update = db.prepare(
    "UPDATE telegram_conversations SET user_id = ?, bot_id = ?, thread_id = ?, updated_at = ? WHERE chat_id = ?",
  );
  const deleteBot = db.prepare("DELETE FROM telegram_conversations WHERE bot_id = ?");
  const deleteChat = db.prepare("DELETE FROM telegram_conversations WHERE chat_id = ?");

  return {
    upsert(row) {
      const chatId = String(row.chatId ?? "").trim();
      const botId = String(row.botId ?? "").trim();
      const threadId = String(row.threadId ?? "").trim();
      if (!chatId || !botId || !threadId) throw new Error("telegram conversation needs chat, bot, and thread");
      const userId = typeof row.userId === "string" && row.userId.trim() ? row.userId.trim() : null;
      const existing = selectChat.get(chatId);
      if (!existing) {
        insert.run(chatId, userId, botId, threadId, row.now, row.now);
        return toConversation(selectChat.get(chatId)!);
      }
      update.run(userId ?? existing.user_id, botId, threadId, row.now, chatId);
      return toConversation(selectChat.get(chatId)!);
    },
    getByChat(chatId) {
      const row = selectChat.get(String(chatId ?? "").trim());
      return row ? toConversation(row) : null;
    },
    listByBot(botId) {
      return selectBot.all(botId).map(toConversation);
    },
    listByThread(threadId) {
      return selectThread.all(threadId).map(toConversation);
    },
    deleteForBot(botId) {
      deleteBot.run(botId);
    },
    deleteByChat(chatId) {
      deleteChat.run(chatId);
    },
  };
}
