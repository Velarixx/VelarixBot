import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";

import { DATA_DIR } from "../config.ts";
import { defaultDbPath, openDatabase } from "../db/database.ts";
import type { SqliteDatabase } from "../db/sqlite-native.ts";
import { createDiscordConversationsRepository } from "./discord-conversations.ts";

describe("discord conversations repository", () => {
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

  it("upserts an explicit guild/channel binding and does not retarget on later messages", () => {
    const store = createDiscordConversationsRepository(db);
    const first = store.upsert({
      conversationKey: "10/20",
      guildId: "10",
      channelId: "20",
      userId: "30",
      botId: "bot-a",
      velarixThreadId: "thread-a",
      now: 10,
    });
    expect(first).toMatchObject({ conversationKey: "10/20", botId: "bot-a", velarixThreadId: "thread-a" });
    const second = store.upsert({
      conversationKey: "10/20",
      guildId: "10",
      channelId: "20",
      userId: "30",
      botId: "bot-a",
      velarixThreadId: "thread-a",
      now: 20,
    });
    expect(second.createdAt).toBe(10);
    expect(second.updatedAt).toBe(20);
    expect(store.getByKey("10/20")?.botId).toBe("bot-a");
    expect(store.listByThread("thread-a")).toHaveLength(1);
    store.upsert({
      conversationKey: "10/20/99",
      guildId: "10",
      channelId: "20",
      threadId: "99",
      botId: "bot-b",
      velarixThreadId: "thread-b",
      now: 30,
    });
    expect(store.listByBot("bot-a").map((row) => row.conversationKey)).toEqual(["10/20"]);
    store.deleteForBot("bot-a");
    expect(store.getByKey("10/20")).toBeNull();
    expect(store.getByKey("10/20/99")?.botId).toBe("bot-b");
  });
});
