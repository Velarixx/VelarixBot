// Bot repository: ordering, persistence across reopen, legacy-row
// normalization, and boot-time crash recovery.
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "../config.ts";
import { defaultDbPath, openDatabase } from "../db/database.ts";
import type { SqliteDatabase } from "../db/sqlite-native.ts";
import { IdentitySessions } from "../identity.ts";
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

  it("isolates every tenant-scoped lookup and update from other owners and legacy rows", () => {
    const identity = new IdentitySessions(db);
    const userA = identity.upsertGithubIdentity({ githubId: 101, login: "tenant-a" }, 1_000);
    const userB = identity.upsertGithubIdentity({ githubId: 202, login: "tenant-b" }, 1_000);
    const bots = createBotsRepository(db);
    const legacy = makeBot({ name: "Legacy", createdAt: 1_000 });
    const botA = makeBot({ name: "A", createdAt: 2_000 });
    const botASecond = makeBot({ name: "A second", createdAt: 3_000 });
    const botB = makeBot({ name: "B", createdAt: 4_000 });

    bots.insert(legacy);
    bots.forOwner(userA.id).insert(botA);
    bots.forOwner(userA.id).insert(botASecond);
    bots.forOwner(userB.id).insert(botB);

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
    expect(tenantA.get(botB.id)).toBeNull();
    expect(tenantA.getByThread(botB.threadId)).toBeNull();
    expect(tenantA.get(legacy.id)).toBeNull();
    expect(tenantA.getByThread(legacy.threadId)).toBeNull();

    expect(tenantB.update({ ...botA, name: "cross-tenant mutation" })).toBe(false);
    expect(tenantA.get(botA.id)?.name).toBe("A");
    expect(tenantB.update({ ...botB, threadId: botA.threadId, name: "thread collision" })).toBe(false);
    expect(tenantB.get(botB.id)).toMatchObject({ name: "B", threadId: botB.threadId });
    expect(tenantA.update({ ...botA, name: "A updated" })).toBe(true);
    expect(tenantA.get(botA.id)?.name).toBe("A updated");

    // The explicitly unscoped desktop API remains backward-compatible and
    // visible as such; it is not evidence of tenant safety.
    expect(bots.count()).toBe(4);
    expect(bots.get(legacy.id)?.name).toBe("Legacy");
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
