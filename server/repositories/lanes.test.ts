// Durable lane idempotency keys: one key never produces two work ids,
// including across a process restart (reopen the same SQLite file).
import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "../config.ts";
import { defaultDbPath, openDatabase } from "../db/database.ts";
import type { SqliteDatabase } from "../db/sqlite-native.ts";
import { createLaneIdempotencyRepository, type LaneIdempotencyRepository } from "./lanes.ts";

describe("lane idempotency repository", () => {
  let db: SqliteDatabase;
  let keys: LaneIdempotencyRepository;

  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    db = openDatabase(defaultDbPath());
    keys = createLaneIdempotencyRepository(db);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  });

  it("claims a key once and returns the same work id on retry", () => {
    const first = keys.claim({
      key: "channel:discord:msg-1",
      workId: "work-a",
      lane: "channel",
      botId: "bot-1",
      createdAt: 1_000,
    });
    expect(first.created).toBe(true);
    expect(first.row).toMatchObject({
      key: "channel:discord:msg-1",
      workId: "work-a",
      lane: "channel",
      botId: "bot-1",
      status: "queued",
    });
    const second = keys.claim({
      key: "channel:discord:msg-1",
      workId: "work-b",
      lane: "channel",
      botId: "bot-1",
      createdAt: 2_000,
    });
    expect(second.created).toBe(false);
    expect(second.row.workId).toBe("work-a");
    expect(keys.get("channel:discord:msg-1")?.workId).toBe("work-a");
  });

  it("survives a reopen so a retried fire cannot mint a second work id", () => {
    keys.claim({
      key: "background:routine-1@1000",
      workId: "work-1",
      lane: "background",
      botId: "bot-1",
      createdAt: 1_000,
    });
    keys.setStatus("background:routine-1@1000", "done");
    db.close();
    db = openDatabase(defaultDbPath());
    keys = createLaneIdempotencyRepository(db);
    const retry = keys.claim({
      key: "background:routine-1@1000",
      workId: "work-2",
      lane: "background",
      botId: "bot-1",
      createdAt: 9_000,
    });
    expect(retry).toMatchObject({ created: false, row: { workId: "work-1", status: "done" } });
  });

  it("deletes keys for one bot without touching another", () => {
    keys.claim({ key: "user:a", workId: "w1", lane: "user", botId: "bot-a", createdAt: 1 });
    keys.claim({ key: "user:b", workId: "w2", lane: "user", botId: "bot-b", createdAt: 2 });
    keys.deleteForBot("bot-a");
    expect(keys.get("user:a")).toBeNull();
    expect(keys.get("user:b")?.botId).toBe("bot-b");
  });
});
