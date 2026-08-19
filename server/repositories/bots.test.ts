// Bot repository: ordering, persistence across reopen, legacy-row
// normalization, and boot-time crash recovery.
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "../config.ts";
import { defaultDbPath, openDatabase } from "../db/database.ts";
import type { SqliteDatabase } from "../db/sqlite-native.ts";
import { IdentitySessions } from "../identity.ts";
import {
  PUBLIC_BOT_HANDLE_ENTROPY_BITS,
  PUBLIC_BOT_HANDLE_LENGTH,
  PUBLIC_BOT_HANDLE_PATTERN,
  generatePublicBotHandle,
} from "../public-bot-handle.ts";
import { zeroUsage, type BotRecord } from "../store.ts";
import { createBotsRepository } from "./bots.ts";
import { createRepositories } from "./index.ts";

function makeBot(overrides: Partial<BotRecord> = {}): BotRecord {
  const id = overrides.id ?? `bot-${Math.random().toString(36).slice(2)}`;
  return {
    id,
    threadId: overrides.threadId ?? `thread-${id}`,
    name: "Testy",
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
    ...overrides,
  };
}

describe("bots repository", () => {
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

  it("lists newest-first and persists updates across reopen", () => {
    const bots = createBotsRepository(db);
    const first = makeBot({ name: "First" });
    const second = makeBot({ name: "Second" });
    bots.insert(first);
    bots.insert(second);
    expect(bots.list().map((b) => b.name)).toEqual(["Second", "First"]);
    expect(bots.count()).toBe(2);
    expect(bots.getByThread(first.threadId)?.id).toBe(first.id);

    bots.update({ ...first, name: "Renamed", resumeCursors: { claude: "sess-abc" }, usage: { input: 12, output: 5, cost: null } });
    db.close();
    db = openDatabase(defaultDbPath());
    const reloaded = createBotsRepository(db).get(first.id);
    expect(reloaded).toMatchObject({ name: "Renamed", resumeCursors: { claude: "sess-abc" }, usage: { input: 12, output: 5, cost: null } });
  });

  it("normalizes legacy rows without losing cursors", () => {
    const bots = createBotsRepository(db);
    const bot = makeBot();
    bots.insert(bot);
    // simulate a record written by an older build: fields missing entirely
    const legacy: Record<string, unknown> = { ...bot, resumeCursors: { codex: "cursor" } };
    delete legacy.computer;
    delete legacy.state;
    db.prepare("UPDATE bots SET data = ? WHERE id = ?").run(JSON.stringify(legacy), bot.id);
    expect(bots.get(bot.id)).toMatchObject({ computer: "off", state: "IDLE", resumeCursors: { codex: "cursor" } });
  });

  it("recoverInterrupted flips a crashed RUNNING bot to BLOCKED/interrupted at boot only", () => {
    const bots = createBotsRepository(db);
    const running = makeBot({ busy: true, state: "RUNNING" });
    const idle = makeBot();
    bots.insert(running);
    bots.insert(idle);
    // a live read must NOT flip state (the bot is genuinely running)
    expect(bots.get(running.id)).toMatchObject({ busy: true, state: "RUNNING" });
    expect(bots.recoverInterrupted()).toBe(1);
    expect(bots.get(running.id)).toMatchObject({ busy: false, state: "BLOCKED", stateDetail: "interrupted" });
    expect(bots.get(idle.id)).toMatchObject({ busy: false, state: "IDLE" });
    expect(bots.recoverInterrupted()).toBe(0); // idempotent
  });

  it("defines a bounded URL-safe handle with at least 128 bits of entropy", () => {
    const handle = generatePublicBotHandle();
    expect(PUBLIC_BOT_HANDLE_ENTROPY_BITS).toBeGreaterThanOrEqual(128);
    expect(handle).toHaveLength(PUBLIC_BOT_HANDLE_LENGTH);
    expect(handle).toMatch(PUBLIC_BOT_HANDLE_PATTERN);
  });

  it("isolates every tenant-scoped lookup and update from other owners and legacy rows", () => {
    const identity = new IdentitySessions(db);
    const userA = identity.upsertGithubIdentity({ githubId: 101, login: "tenant-a" }, 1_000);
    const userB = identity.upsertGithubIdentity({ githubId: 202, login: "tenant-b" }, 1_000);
    const generatedHandles = ["B".repeat(22), "C".repeat(22), "D".repeat(22)];
    const bots = createBotsRepository(db, { generatePublicHandle: () => generatedHandles.shift()! });
    const legacy = makeBot({ name: "Legacy", createdAt: 1_000 });
    const botA = makeBot({ name: "A", createdAt: 2_000 });
    const botASecond = makeBot({ name: "A second", createdAt: 3_000 });
    const botB = makeBot({ name: "B", createdAt: 4_000 });

    bots.insert(legacy);
    const insertedA = bots.forOwner(userA.id).insert(botA);
    const insertedASecond = bots.forOwner(userA.id).insert(botASecond);
    const insertedB = bots.forOwner(userB.id).insert(botB);

    expect(new Set([insertedA.publicHandle, insertedASecond.publicHandle, insertedB.publicHandle]).size).toBe(3);
    expect(insertedA.publicHandle).toMatch(PUBLIC_BOT_HANDLE_PATTERN);

    expect(
      db.prepare<{ owner_id: string | null }>("SELECT owner_id FROM threads WHERE id = ?").get(botA.threadId),
    ).toEqual({ owner_id: userA.id });
    expect(
      db.prepare<{ owner_id: string | null }>("SELECT owner_id FROM threads WHERE id = ?").get(botB.threadId),
    ).toEqual({ owner_id: userB.id });
    expect(
      db.prepare<{ owner_id: string | null }>("SELECT owner_id FROM threads WHERE id = ?").get(legacy.threadId),
    ).toEqual({ owner_id: null });

    const tenantA = bots.forOwner(userA.id);
    const tenantB = bots.forOwner(userB.id);
    expect(tenantA.list().map((bot) => bot.id)).toEqual([botASecond.id, botA.id]);
    expect(tenantB.list().map((bot) => bot.id)).toEqual([botB.id]);
    expect(tenantA.count()).toBe(2);
    expect(tenantB.count()).toBe(1);
    expect(tenantA.get(botA.id)?.name).toBe("A");
    expect(tenantA.getByThread(botA.threadId)?.id).toBe(botA.id);
    expect(tenantA.getByPublicHandle(insertedA.publicHandle)?.id).toBe(botA.id);
    expect(tenantB.getByPublicHandle(insertedA.publicHandle)).toBeNull();
    expect(tenantA.getByPublicHandle(insertedB.publicHandle)).toBeNull();
    expect(tenantA.getByPublicHandle("malformed")).toBeNull();
    expect(tenantA.get(botB.id)).toBeNull();
    expect(tenantA.getByThread(botB.threadId)).toBeNull();
    expect(tenantA.get(legacy.id)).toBeNull();
    expect(tenantA.getByThread(legacy.threadId)).toBeNull();

    expect(tenantB.update({ ...botA, name: "cross-tenant mutation" })).toBe(false);
    expect(tenantA.get(botA.id)?.name).toBe("A");
    expect(tenantB.update({ ...botB, threadId: botA.threadId, name: "thread collision" })).toBe(false);
    expect(tenantB.get(botB.id)).toMatchObject({ name: "B", threadId: botB.threadId });
    expect(tenantA.update({ ...insertedA, name: "A updated" })).toBe(true);
    expect(tenantA.get(botA.id)?.name).toBe("A updated");
    expect(db.prepare<{ data: string }>("SELECT data FROM bots WHERE id = ?").get(botA.id)?.data)
      .not.toContain("publicHandle");

    // The explicitly unscoped desktop API remains backward-compatible and
    // visible as such; it is not evidence of tenant safety.
    expect(bots.count()).toBe(4);
    expect(bots.get(legacy.id)?.name).toBe("Legacy");
    expect(db.prepare<{ public_handle: string | null }>("SELECT public_handle FROM bots WHERE id = ?").get(legacy.id))
      .toEqual({ public_handle: null });
  });

  it("persists an owned handle across reopen", () => {
    const identity = new IdentitySessions(db);
    const owner = identity.upsertGithubIdentity({ githubId: 250, login: "stable-owner" }, 1_000);
    const inserted = createBotsRepository(db).forOwner(owner.id).insert(makeBot());
    db.close();
    db = openDatabase(defaultDbPath());
    expect(createBotsRepository(db).forOwner(owner.id).get(inserted.id)?.publicHandle).toBe(inserted.publicHandle);
  });

  it("never reuses a reserved handle and rolls back a colliding owned insert", () => {
    const identity = new IdentitySessions(db);
    const owner = identity.upsertGithubIdentity({ githubId: 251, login: "handle-collision" }, 1_000);
    const fixedHandle = "A".repeat(PUBLIC_BOT_HANDLE_LENGTH);
    const bots = createBotsRepository(db, { generatePublicHandle: () => fixedHandle });
    const first = bots.forOwner(owner.id).insert(makeBot());
    expect(first.publicHandle).toBe(fixedHandle);
    db.prepare("DELETE FROM bots WHERE id = ?").run(first.id);
    db.prepare("DELETE FROM threads WHERE id = ?").run(first.threadId);

    const colliding = makeBot();
    expect(() => bots.forOwner(owner.id).insert(colliding)).toThrow(/UNIQUE/i);
    expect(bots.forOwner(owner.id).get(colliding.id)).toBeNull();
    expect(db.prepare("SELECT 1 FROM threads WHERE id = ?").get(colliding.threadId)).toBeUndefined();
    expect(db.prepare<{ n: number }>("SELECT count(*) AS n FROM public_bot_handles").get()?.n).toBe(1);
  });

  it("rejects malformed and nonexistent owners without leaving bot or thread rows", () => {
    const bots = createBotsRepository(db);
    expect(() => bots.forOwner("not-a-uuid")).toThrow(/internal UUID/);

    const orphan = makeBot();
    expect(() => bots.forOwner(randomUUID()).insert(orphan)).toThrow(/FOREIGN KEY/i);
    expect(bots.get(orphan.id)).toBeNull();
    expect(db.prepare("SELECT 1 FROM threads WHERE id = ?").get(orphan.threadId)).toBeUndefined();
  });

  it("rolls back both rows when an owned bot or thread id collides", () => {
    const identity = new IdentitySessions(db);
    const user = identity.upsertGithubIdentity({ githubId: 303, login: "collision-owner" }, 1_000);
    const bots = createBotsRepository(db);
    const existing = makeBot();
    bots.forOwner(user.id).insert(existing);

    const botCollision = makeBot({ id: existing.id, threadId: "fresh-thread" });
    expect(() => bots.forOwner(user.id).insert(botCollision)).toThrow(/UNIQUE/i);
    expect(db.prepare("SELECT 1 FROM threads WHERE id = ?").get(botCollision.threadId)).toBeUndefined();

    const threadCollision = makeBot({ id: "fresh-bot", threadId: existing.threadId });
    expect(() => bots.forOwner(user.id).insert(threadCollision)).toThrow(/UNIQUE/i);
    expect(bots.get(threadCollision.id)).toBeNull();
    expect(bots.count()).toBe(1);
    expect(db.prepare<{ n: number }>("SELECT count(*) AS n FROM threads").get()?.n).toBe(1);
  });

  it("deleteBotCascade removes the bot, thread, messages, routines, runs, and binding in one transaction", () => {
    const repos = createRepositories(db);
    const bot = makeBot();
    repos.bots.insert(bot);
    repos.messages.append(bot.threadId, { role: "user", kind: "text", text: "hi" });
    repos.eventLog.append({
      eventId: "ev-1",
      provider: "fake",
      threadId: bot.threadId,
      createdAt: new Date().toISOString(),
      type: "turn.started",
    });
    repos.routines.insert({
      id: "r1",
      botId: bot.id,
      name: "R",
      prompt: "P",
      schedule: { kind: "interval", everyMinutes: 5 },
      enabled: true,
      running: false,
      nextRunAt: Date.now(),
      lastRunAt: null,
      lastResult: null,
      createdAt: Date.now(),
      missedPolicy: "run-once",
    });
    repos.routines.claimRun({ routineId: "r1", botId: bot.id, startedAt: Date.now(), leaseUntil: Date.now() + 60_000, kind: "manual" });
    repos.computerBindings.record(bot.id, "box-1");

    expect(repos.deleteBotCascade(bot.id)).toBe(true);
    expect(repos.bots.get(bot.id)).toBeNull();
    expect(repos.messages.countForThread(bot.threadId)).toBe(0);
    expect(repos.eventLog.countForThread(bot.threadId)).toBe(0);
    expect(repos.routines.get("r1")).toBeNull();
    expect(repos.routines.runsFor("r1")).toEqual([]);
    expect(repos.computerBindings.get(bot.id)).toBeNull();
    expect(db.prepare("SELECT 1 FROM threads WHERE id = ?").get(bot.threadId)).toBeUndefined();
    expect(repos.deleteBotCascade(bot.id)).toBe(false);
  });
});
