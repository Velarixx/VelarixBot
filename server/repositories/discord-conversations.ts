// Discord conversation → VelarixBot bot/group binding. One row per
// guild/channel/thread so inbound messages cannot retarget another agent.
import type { SqliteDatabase } from "../db/sqlite-native.ts";

export interface DiscordConversation {
  conversationKey: string;
  guildId: string | null;
  channelId: string;
  threadId: string | null;
  userId: string | null;
  botId: string | null;
  groupId: string | null;
  velarixThreadId: string;
  createdAt: number;
  updatedAt: number;
}

interface ConversationRow {
  conversation_key: string;
  guild_id: string | null;
  channel_id: string;
  thread_id: string | null;
  user_id: string | null;
  bot_id: string | null;
  group_id: string | null;
  velarix_thread_id: string;
  created_at: number;
  updated_at: number;
}

function toConversation(row: ConversationRow): DiscordConversation {
  return {
    conversationKey: row.conversation_key,
    guildId: row.guild_id,
    channelId: row.channel_id,
    threadId: row.thread_id,
    userId: row.user_id,
    botId: row.bot_id,
    groupId: row.group_id,
    velarixThreadId: row.velarix_thread_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface DiscordConversationsRepository {
  upsert(row: {
    conversationKey: string;
    guildId?: string | null;
    channelId: string;
    threadId?: string | null;
    userId?: string | null;
    botId?: string | null;
    groupId?: string | null;
    velarixThreadId: string;
    now: number;
  }): DiscordConversation;
  getByKey(conversationKey: string): DiscordConversation | null;
  listByBot(botId: string): DiscordConversation[];
  listByGroup(groupId: string): DiscordConversation[];
  listByThread(velarixThreadId: string): DiscordConversation[];
  deleteForBot(botId: string): void;
  deleteByKey(conversationKey: string): void;
}

export function createDiscordConversationsRepository(db: SqliteDatabase): DiscordConversationsRepository {
  const selectKey = db.prepare<ConversationRow>(
    "SELECT conversation_key, guild_id, channel_id, thread_id, user_id, bot_id, group_id, velarix_thread_id, created_at, updated_at FROM discord_conversations WHERE conversation_key = ?",
  );
  const selectBot = db.prepare<ConversationRow>(
    "SELECT conversation_key, guild_id, channel_id, thread_id, user_id, bot_id, group_id, velarix_thread_id, created_at, updated_at FROM discord_conversations WHERE bot_id = ? ORDER BY updated_at, conversation_key",
  );
  const selectGroup = db.prepare<ConversationRow>(
    "SELECT conversation_key, guild_id, channel_id, thread_id, user_id, bot_id, group_id, velarix_thread_id, created_at, updated_at FROM discord_conversations WHERE group_id = ? ORDER BY updated_at, conversation_key",
  );
  const selectThread = db.prepare<ConversationRow>(
    "SELECT conversation_key, guild_id, channel_id, thread_id, user_id, bot_id, group_id, velarix_thread_id, created_at, updated_at FROM discord_conversations WHERE velarix_thread_id = ? ORDER BY updated_at, conversation_key",
  );
  const insert = db.prepare(
    "INSERT INTO discord_conversations(conversation_key, guild_id, channel_id, thread_id, user_id, bot_id, group_id, velarix_thread_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const update = db.prepare(
    "UPDATE discord_conversations SET guild_id = ?, channel_id = ?, thread_id = ?, user_id = ?, bot_id = ?, group_id = ?, velarix_thread_id = ?, updated_at = ? WHERE conversation_key = ?",
  );
  const deleteBot = db.prepare("DELETE FROM discord_conversations WHERE bot_id = ?");
  const deleteKey = db.prepare("DELETE FROM discord_conversations WHERE conversation_key = ?");

  return {
    upsert(row) {
      const conversationKey = String(row.conversationKey ?? "").trim();
      const channelId = String(row.channelId ?? "").trim();
      const velarixThreadId = String(row.velarixThreadId ?? "").trim();
      if (!conversationKey || !channelId || !velarixThreadId) {
        throw new Error("discord conversation needs key, channel, and velarix thread");
      }
      const botId = typeof row.botId === "string" && row.botId.trim() ? row.botId.trim() : null;
      const groupId = typeof row.groupId === "string" && row.groupId.trim() ? row.groupId.trim() : null;
      if (!botId && !groupId) throw new Error("discord conversation needs a bot or group binding");
      const guildId = typeof row.guildId === "string" && row.guildId.trim() ? row.guildId.trim() : null;
      const threadId = typeof row.threadId === "string" && row.threadId.trim() ? row.threadId.trim() : null;
      const userId = typeof row.userId === "string" && row.userId.trim() ? row.userId.trim() : null;
      const existing = selectKey.get(conversationKey);
      if (!existing) {
        insert.run(conversationKey, guildId, channelId, threadId, userId, botId, groupId, velarixThreadId, row.now, row.now);
        return toConversation(selectKey.get(conversationKey)!);
      }
      update.run(
        guildId ?? existing.guild_id,
        channelId,
        threadId ?? existing.thread_id,
        userId ?? existing.user_id,
        botId ?? existing.bot_id,
        groupId ?? existing.group_id,
        velarixThreadId,
        row.now,
        conversationKey,
      );
      return toConversation(selectKey.get(conversationKey)!);
    },
    getByKey(conversationKey) {
      const row = selectKey.get(String(conversationKey ?? "").trim());
      return row ? toConversation(row) : null;
    },
    listByBot(botId) {
      return selectBot.all(botId).map(toConversation);
    },
    listByGroup(groupId) {
      return selectGroup.all(groupId).map(toConversation);
    },
    listByThread(velarixThreadId) {
      return selectThread.all(velarixThreadId).map(toConversation);
    },
    deleteForBot(botId) {
      deleteBot.run(botId);
    },
    deleteByKey(conversationKey) {
      deleteKey.run(conversationKey);
    },
  };
}
