// Message repository: append durability shape (O(1) appends, blobs on
// disk), patch merge semantics, and the transactional thread delete.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "../config.ts";
import { blobsDir } from "../db/blobs.ts";
import { defaultDbPath, openDatabase } from "../db/database.ts";
import type { SqliteDatabase } from "../db/sqlite-native.ts";
import { putBlob } from "../db/blobs.ts";
import { zeroUsage } from "../store.ts";
import { createEventLogRepository } from "./event-log.ts";
import { createMessagesRepository } from "./messages.ts";
import { createRepositories } from "./index.ts";

const PNG_BASE64 = Buffer.from("not-really-a-png-but-bytes-are-bytes").toString("base64");

describe("messages repository", () => {
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

  it("appends, reads back in order, and persists across reopen", () => {
    const messages = createMessagesRepository(db);
    messages.append("t1", { role: "user", kind: "text", text: "one" });
    const second = messages.append("t1", { role: "bot", kind: "text", text: "two" });
    expect(messages.forThread("t1").map((m) => m.text)).toEqual(["one", "two"]);
    expect(messages.find("t1", second.id)?.text).toBe("two");
    db.close();
    db = openDatabase(defaultDbPath());
    expect(createMessagesRepository(db).forThread("t1").map((m) => m.text)).toEqual(["one", "two"]);
  });

  it("patches merge like the JSON store did (card kept unless replaced)", () => {
    const messages = createMessagesRepository(db);
    const m = messages.append("t1", {
      role: "bot",
      kind: "options",
      card: { title: "T", subtitle: "S", options: ["a", "b"] },
    });
    const patched = messages.patch("t1", m.id, { text: "answered" });
    expect(patched?.card?.options).toEqual(["a", "b"]);
    expect(patched?.text).toBe("answered");
    const answered = messages.patch("t1", m.id, { card: { ...m.card!, answered: "a" } });
    expect(answered?.card?.answered).toBe("a");
    expect(messages.patch("t1", "missing", {})).toBeNull();
  });

  it("stores screenshot bytes on disk, content-hash indexed — never in SQLite", () => {
    const messages = createMessagesRepository(db);
    const m = messages.append("t1", { role: "bot", kind: "screen", png: PNG_BASE64, mime: "image/png" });
    const row = db.prepare<{ png_hash: string | null; data: string }>("SELECT png_hash, data FROM messages WHERE id = ?").get(m.id)!;
    const expectedHash = createHash("sha256").update(Buffer.from(PNG_BASE64, "base64")).digest("hex");
    expect(row.png_hash).toBe(expectedHash);
    expect(row.data).not.toContain(PNG_BASE64);
    expect(existsSync(join(blobsDir(), expectedHash))).toBe(true);
    expect(readFileSync(join(blobsDir(), expectedHash)).toString("base64")).toBe(PNG_BASE64);
    // reads rehydrate the payload transparently
    expect(messages.forThread("t1")[0].png).toBe(PNG_BASE64);
  });

  it("pages newest-n and before= without loading slim png bytes", () => {
    const messages = createMessagesRepository(db);
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      ids.push(messages.append("t-page", { role: "user", kind: "text", text: `m${i}` }).id);
    }
    const screen = messages.append("t-page", { role: "bot", kind: "screen", png: PNG_BASE64, mime: "image/png" });
    const newest = messages.pageForThread("t-page", { limit: 2, slim: true })!;
    expect(newest.messages.map((m) => m.id)).toEqual([ids[5], screen.id]);
    expect(newest.hasMore).toBe(true);
    expect(newest.messages[1]).toMatchObject({ kind: "screen", hasImage: true });
    expect(newest.messages[1].png).toBeUndefined();

    const older = messages.pageForThread("t-page", { limit: 2, before: ids[5], slim: true })!;
    expect(older.messages.map((m) => m.id)).toEqual([ids[3], ids[4]]);
    expect(older.hasMore).toBe(true);
    expect(messages.pageForThread("t-page", { limit: 2, before: "missing" })).toBeNull();

    const image = messages.readImage("t-page", screen.id)!;
    expect(image.bytes.toString("base64")).toBe(PNG_BASE64);
    expect(image.mime).toBe("image/png");
    expect(messages.readImage("t-page", ids[0])).toBeNull();
  });

  it("append #100,001 does not rewrite the prior 100,000", () => {
    const messages = createMessagesRepository(db);
    const insertAll = db.transaction(() => {
      for (let i = 1; i <= 100_000; i++) {
        messages.append("big", { role: "user", kind: "text", text: `m${i}` });
      }
    });
    insertAll();
    expect(messages.countForThread("big")).toBe(100_000);
    // settle everything into the main file, then hash it
    db.pragma("wal_checkpoint(TRUNCATE)");
    const path = defaultDbPath();
    const before = createHash("sha256").update(readFileSync(path)).digest("hex");
    messages.append("big", { role: "user", kind: "text", text: "m100001" });
    // the append landed in the WAL; the 100,000 committed messages in the
    // main database file were not rewritten — not a single byte
    const after = createHash("sha256").update(readFileSync(path)).digest("hex");
    expect(after).toBe(before);
    expect(messages.countForThread("big")).toBe(100_001);
  }, 60_000);

  it("thread delete is transactional: an injected failure rolls everything back", () => {
    const messages = createMessagesRepository(db);
    const events = createEventLogRepository(db);
    messages.append("t-del", { role: "user", kind: "text", text: "keep or drop together" });
    messages.append("t-del", { role: "bot", kind: "screen", png: PNG_BASE64 });
    events.append({
      eventId: "ev-1",
      provider: "fake",
      threadId: "t-del",
      createdAt: new Date().toISOString(),
      type: "turn.started",
    });
    // injected failure on the LAST leg of the delete
    db.exec("CREATE TRIGGER fail_delete BEFORE DELETE ON event_log BEGIN SELECT RAISE(ABORT, 'injected'); END;");
    expect(() => messages.deleteThread("t-del")).toThrow(/injected/);
    expect(messages.countForThread("t-del")).toBe(2);
    expect(events.countForThread("t-del")).toBe(1);
    expect(db.prepare("SELECT 1 FROM threads WHERE id = 't-del'").get()).toBeTruthy();

    db.exec("DROP TRIGGER fail_delete;");
    expect(messages.deleteThread("t-del")).toBe(true);
    expect(messages.countForThread("t-del")).toBe(0);
    expect(events.countForThread("t-del")).toBe(0);
    expect(db.prepare("SELECT 1 FROM threads WHERE id = 't-del'").get()).toBeUndefined();
  });

  it("thread delete garbage-collects unreferenced blobs, keeps shared ones", () => {
    const messages = createMessagesRepository(db);
    messages.append("t-a", { role: "bot", kind: "screen", png: PNG_BASE64 });
    messages.append("t-b", { role: "bot", kind: "screen", png: PNG_BASE64 });
    const hash = createHash("sha256").update(Buffer.from(PNG_BASE64, "base64")).digest("hex");
    messages.deleteThread("t-a");
    expect(existsSync(join(blobsDir(), hash))).toBe(true); // t-b still refs it
    messages.deleteThread("t-b");
    expect(existsSync(join(blobsDir(), hash))).toBe(false);
  });

  it("screenshot GC does not delete an avatar blob the bot still references", () => {
    const repos = createRepositories(db);
    const avatarHash = putBlob(Buffer.from("bot-avatar-raster"));
    const bot = {
      id: "bot-avatar",
      threadId: "t-avatar",
      name: "Face",
      title: "",
      description: "",
      notifications: true,
      color: "blue" as const,
      iconShape: "cursor" as const,
      unread: false,
      modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
      resumeCursors: {},
      computer: "off",
      busy: false,
      state: "IDLE" as const,
      usage: zeroUsage(),
      createdAt: Date.now(),
      avatarImageHash: avatarHash,
    };
    repos.bots.insert(bot);
    repos.messages.append("t-avatar", { role: "bot", kind: "screen", png: PNG_BASE64 });
    const shotHash = createHash("sha256").update(Buffer.from(PNG_BASE64, "base64")).digest("hex");
    expect(shotHash).not.toBe(avatarHash);

    const other = {
      ...bot,
      id: "bot-other",
      threadId: "t-other",
      avatarImageHash: undefined,
    };
    repos.bots.insert(other);
    repos.messages.append("t-other", { role: "bot", kind: "screen", png: PNG_BASE64 });

    // screenshot GC of the other thread must not take the avatar
    expect(repos.deleteBotCascade(other.id)).toBe(true);
    expect(existsSync(join(blobsDir(), shotHash))).toBe(true); // t-avatar still refs it
    expect(existsSync(join(blobsDir(), avatarHash))).toBe(true);

    expect(repos.deleteBotCascade(bot.id)).toBe(true);
    expect(existsSync(join(blobsDir(), avatarHash))).toBe(false);
    expect(existsSync(join(blobsDir(), shotHash))).toBe(false);
  });
});
