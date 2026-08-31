// Message repository: append durability shape (O(1) appends, blobs on
// disk), patch merge semantics, and the transactional thread delete.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "../config.ts";
import { blobsDir, listBlobs } from "../db/blobs.ts";
import { defaultDbPath, openDatabase } from "../db/database.ts";
import type { SqliteDatabase } from "../db/sqlite-native.ts";
import { putBlob } from "../db/blobs.ts";
import { IdentitySessions } from "../identity.ts";
import { zeroUsage, type BotRecord } from "../store.ts";
import { createEventLogRepository } from "./event-log.ts";
import { createMessagesRepository } from "./messages.ts";
import { createRepositories } from "./index.ts";

const PNG_BASE64 = Buffer.from("not-really-a-png-but-bytes-are-bytes").toString("base64");

function makeBot(id: string): BotRecord {
  return {
    id,
    threadId: `thread-${id}`,
    name: id,
    title: "",
    description: "",
    notifications: true,
    color: "blue",
    iconShape: "cursor",
    unread: false,
    modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
    resumeCursors: {},
    computer: "off",
    busy: false,
    state: "IDLE",
    usage: zeroUsage(),
    createdAt: Date.now(),
  };
}

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

  it("isolates owner-bound list, page, find, image, and count with exact foreign ids", () => {
    const identity = new IdentitySessions(db);
    const userA = identity.upsertGithubIdentity({ githubId: 101, login: "tenant-a" }, 1_000);
    const userB = identity.upsertGithubIdentity({ githubId: 202, login: "tenant-b" }, 1_000);
    const repos = createRepositories(db);
    const botA = makeBot("bot-a");
    const botB = makeBot("bot-b");
    repos.bots.forOwner(userA.id).insert(botA);
    repos.bots.forOwner(userB.id).insert(botB);
    const tenantA = repos.messages.forOwner(userA.id);
    const tenantB = repos.messages.forOwner(userB.id);
    const firstA = tenantA.append(botA.threadId, { role: "user", kind: "text", text: "a1" });
    const secondA = tenantA.append(botA.threadId, { role: "bot", kind: "text", text: "a2" });
    const imageB = tenantB.append(botB.threadId, { role: "bot", kind: "screen", png: PNG_BASE64, mime: "image/png" });
    const legacy = repos.messages.append("legacy-thread", { role: "user", kind: "text", text: "legacy" });

    expect(() => repos.messages.forOwner("not-a-uuid")).toThrow(/internal UUID/);
    expect(tenantA.forThread(botA.threadId).map((message) => message.id)).toEqual([firstA.id, secondA.id]);
    expect(tenantA.forThread(botB.threadId)).toEqual([]);
    expect(tenantA.forThread("legacy-thread")).toEqual([]);
    expect(tenantA.countForThread(botA.threadId)).toBe(2);
    expect(tenantA.countForThread(botB.threadId)).toBe(0);
    expect(tenantA.countForThread("legacy-thread")).toBe(0);
    expect(tenantA.find(botB.threadId, imageB.id)).toBeNull();
    expect(tenantA.find(botA.threadId, imageB.id)).toBeNull();
    expect(tenantA.find("legacy-thread", legacy.id)).toBeNull();
    expect(tenantA.readImage(botB.threadId, imageB.id)).toBeNull();
    expect(tenantB.readImage(botB.threadId, imageB.id)?.bytes.toString("base64")).toBe(PNG_BASE64);
    expect(tenantA.pageForThread(botB.threadId, { limit: 10, before: imageB.id })).toBeNull();
    expect(tenantA.pageForThread("legacy-thread", { limit: 10 })).toBeNull();

    const newest = tenantA.pageForThread(botA.threadId, { limit: 1, slim: true })!;
    expect(newest.messages.map((message) => message.id)).toEqual([secondA.id]);
    expect(newest.hasMore).toBe(true);
    expect(tenantA.pageForThread(botA.threadId, { limit: 1, before: secondA.id })?.messages.map((message) => message.id)).toEqual([
      firstA.id,
    ]);
    expect(tenantA.pageForThread(botA.threadId, { limit: 1, before: imageB.id })).toBeNull();
  });

  it("rejects cross-tenant mutation before blob writes and preserves safe owner blob GC", () => {
    const identity = new IdentitySessions(db);
    const userA = identity.upsertGithubIdentity({ githubId: 303, login: "tenant-a" }, 1_000);
    const userB = identity.upsertGithubIdentity({ githubId: 404, login: "tenant-b" }, 1_000);
    const repos = createRepositories(db);
    const botA = makeBot("mutation-a");
    const botB = makeBot("mutation-b");
    repos.bots.forOwner(userA.id).insert(botA);
    repos.bots.forOwner(userB.id).insert(botB);
    const tenantA = repos.messages.forOwner(userA.id);
    const tenantB = repos.messages.forOwner(userB.id);
    const ownA = tenantA.append(botA.threadId, { role: "user", kind: "text", text: "owner may edit" });
    const imageB = tenantB.append(botB.threadId, { role: "bot", kind: "screen", png: PNG_BASE64 });
    const legacy = repos.messages.append("legacy-mutation", { role: "user", kind: "text", text: "legacy" });
    db.prepare("INSERT INTO threads(id, bot_id, created_at) VALUES (?, NULL, ?)").run("group-thread", 1_000);
    db.prepare("INSERT INTO groups(id, thread_id, created_at, data) VALUES (?, ?, ?, ?)").run(
      "group-1",
      "group-thread",
      1_000,
      JSON.stringify({ id: "group-1" }),
    );
    const groupMessage = repos.messages.append("group-thread", { role: "user", kind: "text", text: "group" });
    repos.eventLog.append({
      eventId: "foreign-event",
      provider: "fake",
      threadId: botB.threadId,
      createdAt: new Date().toISOString(),
      type: "turn.started",
    });

    const before = {
      messages: db.prepare<{ n: number }>("SELECT count(*) AS n FROM messages").get()?.n,
      threads: db.prepare<{ n: number }>("SELECT count(*) AS n FROM threads").get()?.n,
      events: db.prepare<{ n: number }>("SELECT count(*) AS n FROM event_log").get()?.n,
      blobs: listBlobs().sort(),
    };
    const unauthorizedPng = Buffer.from("must-not-be-written").toString("base64");
    expect(() => tenantA.append(botB.threadId, { role: "bot", kind: "screen", png: unauthorizedPng })).toThrow(
      /tenant thread not found/,
    );
    expect(() => tenantA.append("legacy-mutation", { role: "user", kind: "text", text: "claim" })).toThrow(
      /tenant thread not found/,
    );
    expect(() => tenantA.append("group-thread", { role: "user", kind: "text", text: "claim" })).toThrow(
      /tenant thread not found/,
    );
    expect(() => tenantA.append("missing-thread", { role: "user", kind: "text", text: "create" })).toThrow(
      /tenant thread not found/,
    );
    expect(tenantA.patch(botB.threadId, imageB.id, { png: unauthorizedPng })).toBeNull();
    expect(tenantA.patch("legacy-mutation", legacy.id, { text: "changed" })).toBeNull();
    expect(tenantA.patch("group-thread", groupMessage.id, { text: "changed" })).toBeNull();
    expect(tenantA.deleteThread(botB.threadId)).toBe(false);
    expect(tenantA.deleteThread("legacy-mutation")).toBe(false);
    expect(tenantA.deleteThread("group-thread")).toBe(false);
    expect(tenantA.deleteThread("missing-thread")).toBe(false);
    expect({
      messages: db.prepare<{ n: number }>("SELECT count(*) AS n FROM messages").get()?.n,
      threads: db.prepare<{ n: number }>("SELECT count(*) AS n FROM threads").get()?.n,
      events: db.prepare<{ n: number }>("SELECT count(*) AS n FROM event_log").get()?.n,
      blobs: listBlobs().sort(),
    }).toEqual(before);
    expect(tenantB.find(botB.threadId, imageB.id)?.png).toBe(PNG_BASE64);
    expect(repos.eventLog.countForThread(botB.threadId)).toBe(1);

    expect(tenantA.patch(botA.threadId, ownA.id, { text: "owner edited" })?.text).toBe("owner edited");
    const laterA = tenantA.append(botA.threadId, { role: "bot", kind: "text", text: "later" });
    expect(tenantA.pageForThread(botA.threadId, { limit: 1 })?.messages[0].id).toBe(laterA.id);
    expect(tenantA.pageForThread(botA.threadId, { limit: 1, before: laterA.id })?.messages[0].id).toBe(ownA.id);

    db.prepare("INSERT INTO threads(id, bot_id, created_at, owner_id) VALUES (?, NULL, ?, ?)").run(
      "owned-loose-thread",
      2_000,
      userA.id,
    );
    tenantA.append("owned-loose-thread", { role: "bot", kind: "screen", png: PNG_BASE64 });
    repos.eventLog.append({
      eventId: "owned-event",
      provider: "fake",
      threadId: "owned-loose-thread",
      createdAt: new Date().toISOString(),
      type: "turn.started",
    });
    const sharedHash = createHash("sha256").update(Buffer.from(PNG_BASE64, "base64")).digest("hex");
    expect(tenantA.deleteThread("owned-loose-thread")).toBe(true);
    expect(db.prepare("SELECT 1 FROM threads WHERE id = ?").get("owned-loose-thread")).toBeUndefined();
    expect(repos.eventLog.countForThread("owned-loose-thread")).toBe(0);
    expect(existsSync(join(blobsDir(), sharedHash))).toBe(true);

    db.prepare("DELETE FROM bots WHERE id = ?").run(botB.id);
    expect(tenantB.deleteThread(botB.threadId)).toBe(true);
    expect(existsSync(join(blobsDir(), sharedHash))).toBe(false);
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

  it("putFixed inserts, verifies identical replay, and fails closed on conflicts", () => {
    const messages = createMessagesRepository(db);
    messages.append("t-fixed", { role: "user", kind: "text", text: "seed" });
    const payload = { role: "bot" as const, kind: "text" as const, text: "sealed result" };
    const first = messages.putFixed("t-fixed", "dtr:run-1:parent", payload);
    expect(first.status).toBe("inserted");
    const replay = messages.putFixed("t-fixed", "dtr:run-1:parent", payload);
    expect(replay.status).toBe("verified");
    expect(messages.putFixed("missing-thread", "dtr:run-1:other", payload)).toEqual({ status: "missing_thread" });
    expect(messages.putFixed("t-fixed", "dtr:run-1:parent", { ...payload, text: "tampered" })).toEqual({
      status: "conflict",
      code: "payload_mismatch",
    });
    messages.append("t-other", { role: "user", kind: "text", text: "other" });
    expect(messages.putFixed("t-other", "dtr:run-1:parent", payload)).toEqual({
      status: "conflict",
      code: "thread_mismatch",
    });
  });

  it("putFixed screenshot replay keeps the blob and conflict does not replace it", () => {
    const messages = createMessagesRepository(db);
    messages.append("t-shot", { role: "user", kind: "text", text: "seed" });
    const first = messages.putFixed("t-shot", "dtr:shot:parent", {
      role: "bot",
      kind: "screen",
      png: PNG_BASE64,
      mime: "image/png",
    });
    expect(first.status).toBe("inserted");
    const hash = createHash("sha256").update(Buffer.from(PNG_BASE64, "base64")).digest("hex");
    expect(existsSync(join(blobsDir(), hash))).toBe(true);
    expect(
      messages.putFixed("t-shot", "dtr:shot:parent", {
        role: "bot",
        kind: "screen",
        png: PNG_BASE64,
        mime: "image/png",
      }).status,
    ).toBe("verified");
    const other = Buffer.from("different-bytes").toString("base64");
    expect(
      messages.putFixed("t-shot", "dtr:shot:parent", {
        role: "bot",
        kind: "screen",
        png: other,
        mime: "image/png",
      }),
    ).toEqual({ status: "conflict", code: "payload_mismatch" });
    expect(messages.find("t-shot", "dtr:shot:parent")?.png).toBe(PNG_BASE64);
    expect(existsSync(join(blobsDir(), hash))).toBe(true);
  });
});
