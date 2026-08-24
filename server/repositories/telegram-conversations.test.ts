import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";

import { DATA_DIR } from "../config.ts";
import { defaultDbPath, openDatabase } from "../db/database.ts";
import type { SqliteDatabase } from "../db/sqlite-native.ts";
import { createTelegramConversationsRepository } from "./telegram-conversations.ts";

describe("telegram conversations repository", () => {
  let db: SqliteDatabase;

  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    db = openDatabase(defaultDbPath());
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  });

  it("upserts a chat onto a bot thread and keeps later messages on that conversation", () => {
    const store = createTelegramConversationsRepository(db);
    const first = store.upsert({
      chatId: "111",
      userId: "111",
      botId: "bot-a",
      threadId: "thread-a",
      now: 10,
    });
    expect(first).toMatchObject({ chatId: "111", botId: "bot-a", threadId: "thread-a" });
    const second = store.upsert({
      chatId: "111",
      userId: "111",
      botId: "bot-a",
      threadId: "thread-a",
      now: 20,
    });
    expect(second.createdAt).toBe(10);
    expect(second.updatedAt).toBe(20);
    expect(store.getByChat("111")?.threadId).toBe("thread-a");
    expect(store.listByThread("thread-a")).toHaveLength(1);
    store.upsert({ chatId: "222", userId: "222", botId: "bot-b", threadId: "thread-b", now: 30 });
    expect(store.listByBot("bot-a").map((row) => row.chatId)).toEqual(["111"]);
    store.deleteForBot("bot-a");
    expect(store.getByChat("111")).toBeNull();
    expect(store.getByChat("222")?.botId).toBe("bot-b");
  });
});
