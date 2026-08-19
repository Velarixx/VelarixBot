import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "../config.ts";
import { putBlob } from "../db/blobs.ts";
import { defaultDbPath, openDatabase } from "../db/database.ts";
import type { SqliteDatabase } from "../db/sqlite-native.ts";
import { IdentitySessions } from "../identity.ts";
import { PUBLIC_BOT_HANDLE_LENGTH, PUBLIC_BOT_HANDLE_PATTERN } from "../public-bot-handle.ts";
import { createBotsRepository } from "../repositories/bots.ts";
import { createRepositories, type Repositories } from "../repositories/index.ts";
import { createBotsService, type BotsService, type OwnerBotsService } from "./bots.ts";
import { createGroupsService, type GroupsService, type OwnerGroupsService } from "./groups.ts";

const selection = () => ({ instanceId: "claude", model: "claude-sonnet-5" });
const PNG = Buffer.from("owner-a-image").toString("base64");

describe("owner-bound bot and group services", () => {
  let db: SqliteDatabase;
  let repos: Repositories;
  let desktopBots: BotsService;
  let desktopGroups: GroupsService;
  let ownerABots: OwnerBotsService;
  let ownerBBots: OwnerBotsService;
  let ownerAGroups: OwnerGroupsService;
  let ownerBGroups: OwnerGroupsService;

  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    db = openDatabase(defaultDbPath());
    repos = createRepositories(db);
    const identity = new IdentitySessions(db);
    const ownerA = identity.upsertGithubIdentity({ githubId: 101, login: "owner-a" }, 1_000);
    const ownerB = identity.upsertGithubIdentity({ githubId: 202, login: "owner-b" }, 1_000);
    desktopBots = createBotsService({ repos, defaultSelection: selection });
    desktopGroups = createGroupsService({ repos });
    ownerABots = desktopBots.forOwner(ownerA.id);
    ownerBBots = desktopBots.forOwner(ownerB.id);
    ownerAGroups = desktopGroups.forOwner(ownerA.id);
    ownerBGroups = desktopGroups.forOwner(ownerB.id);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  });

  it("exposes a reduced facade and isolates bot list/get/hydration/pagination", () => {
    const legacy = desktopBots.createBot();
    const botA = ownerABots.createBot();
    const botB = ownerBBots.createBot();
    ownerABots.appendMessage(botA.threadId, { role: "user", kind: "text", text: "a-private" });
    ownerBBots.appendMessage(botB.threadId, { role: "user", kind: "text", text: "b-private" });

    expect(Object.keys(ownerABots)).not.toEqual(expect.arrayContaining([
      "forOwner",
      "seedIfEmpty",
      "clearSkillRefs",
      "setResumeCursor",
      "recordTurnUsage",
      "repos",
    ]));
    expect(ownerABots.count()).toBe(1);
    expect(ownerABots.bots().map((bot) => bot.id)).toEqual([botA.id]);
    expect(ownerABots.bot(botB.id)).toBeNull();
    expect(ownerABots.bot(legacy.id)).toBeNull();
    expect(botA.publicHandle).toMatch(PUBLIC_BOT_HANDLE_PATTERN);
    expect(ownerABots.botByPublicHandle(botA.publicHandle)?.id).toBe(botA.id);
    expect(ownerBBots.botByPublicHandle(botA.publicHandle)).toBeNull();
    expect(ownerABots.botByPublicHandle(botB.publicHandle)).toBeNull();
    expect(ownerABots.botByPublicHandle("malformed")).toBeNull();
    expect(ownerABots.botByThread(botB.threadId)).toBeNull();
    expect(ownerABots.botByThread(legacy.threadId)).toBeNull();
    expect(ownerABots.publicBot(botB.id, { messages: 1 })).toBeNull();
    expect(ownerABots.publicBot(legacy.id)).toBeNull();
    expect(ownerABots.publicBots({ messages: 1 })).toMatchObject([
      { id: botA.id, publicHandle: botA.publicHandle, messages: [{ text: "a-private" }], hasMore: true },
    ]);
    expect(ownerABots.patchBot(botA.id, { name: "renamed" })?.publicHandle).toBe(botA.publicHandle);
    expect(ownerABots.pageMessages(botB.threadId, { limit: 20 })).toMatchObject({ ok: false, status: 404 });
    expect(ownerABots.pageMessages(legacy.threadId, { limit: 20 })).toMatchObject({ ok: false, status: 404 });
    expect(JSON.stringify(ownerABots.publicBots())).not.toContain("b-private");
  });

  it("makes foreign and legacy bot/message/image mutations absent and side-effect free", () => {
    const legacy = desktopBots.createBot();
    const botA = ownerABots.createBot();
    const botB = ownerBBots.createBot();
    const messageA = ownerABots.appendMessage(botA.threadId, {
      role: "bot",
      kind: "screen",
      text: "a-screen",
      png: PNG,
      mime: "image/png",
    });
    const messageB = ownerBBots.appendMessage(botB.threadId, { role: "user", kind: "text", text: "b-original" });
    const legacyMessage = desktopBots.appendMessage(legacy.threadId, { role: "user", kind: "text", text: "legacy-original" });
    const avatarHash = putBlob(Buffer.from("owner-a-avatar"));
    const foreignAvatarHash = putBlob(Buffer.from("owner-b-avatar"));
    ownerABots.patchBot(botA.id, { avatarCandidates: [avatarHash], avatarImageHash: avatarHash });
    ownerBBots.patchBot(botB.id, { avatarCandidates: [foreignAvatarHash], avatarImageHash: foreignAvatarHash });

    expect(ownerABots.patchBot(botB.id, { name: "stolen" })).toBeNull();
    expect(ownerABots.patchBot(legacy.id, { name: "claimed" })).toBeNull();
    expect(ownerABots.patchMessage(botB.threadId, messageB.id, { text: "stolen" })).toBeNull();
    expect(ownerABots.patchMessage(legacy.threadId, legacyMessage.id, { text: "claimed" })).toBeNull();
    expect(ownerABots.patchMessage(botA.threadId, messageB.id, { text: "collided" })).toBeNull();
    expect(ownerABots.patchMessage(botA.threadId, legacyMessage.id, { text: "collided" })).toBeNull();
    expect(() => ownerABots.appendMessage(botB.threadId, { role: "user", kind: "text", text: "injected" })).toThrow(
      /tenant thread not found/,
    );
    expect(ownerABots.messagesFor(botB.threadId)).toEqual([]);
    expect(ownerABots.messagesFor(legacy.threadId)).toEqual([]);
    expect(ownerABots.readMessageImage(botB.threadId, messageB.id)).toMatchObject({ ok: false, status: 404 });
    expect(ownerABots.readMessageImage(legacy.threadId, legacyMessage.id)).toMatchObject({ ok: false, status: 404 });
    expect(ownerABots.readMessageImage(botA.threadId, messageB.id)).toMatchObject({ ok: false, status: 404 });
    expect(ownerBBots.readAvatar(botA.id, avatarHash)).toBeNull();
    expect(ownerABots.readAvatar(botA.id, foreignAvatarHash)).toBeNull();
    expect(ownerABots.readAvatar(botA.id, avatarHash)?.bytes.toString()).toBe("owner-a-avatar");
    expect(ownerABots.readMessageImage(botA.threadId, messageA.id)).toMatchObject({ ok: true, mime: "image/png" });

    expect(ownerABots.deleteBot(botB.id)).toBe(false);
    expect(ownerABots.deleteBot(legacy.id)).toBe(false);
    expect(desktopBots.bot(botB.id)?.name).toBe("New Bot");
    expect(desktopBots.bot(legacy.id)?.name).toBe("New Bot");
    expect(desktopBots.messagesFor(botB.threadId).at(-1)?.text).toBe("b-original");
    expect(desktopBots.messagesFor(legacy.threadId).at(-1)?.text).toBe("legacy-original");
    expect(ownerABots.deleteBot(botA.id)).toBe(true);
    expect(desktopBots.bot(botA.id)).toBeNull();
  });

  it("atomically enforces an owner-only creation quota", async () => {
    desktopBots.createBot();
    desktopBots.createBot();
    ownerBBots.createBot();

    const outcomes = await Promise.all(
      Array.from({ length: 6 }, async () => ownerABots.createBotWithinQuota(2)),
    );
    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(2);
    expect(outcomes.filter((outcome) => !outcome.ok)).toHaveLength(4);
    expect(ownerABots.count()).toBe(2);
    expect(ownerBBots.count()).toBe(1);
    expect(desktopBots.count()).toBe(5);
    for (const bot of ownerABots.bots()) {
      expect(ownerABots.messagesFor(bot.threadId)).toHaveLength(2);
      expect(ownerBBots.messagesFor(bot.threadId)).toEqual([]);
    }
  });

  it("rolls back the bot, thread, and first onboarding message when onboarding fails", () => {
    db.exec(`
      CREATE TRIGGER fail_second_onboarding
      BEFORE INSERT ON messages
      WHEN (SELECT count(*) FROM messages WHERE thread_id = NEW.thread_id) >= 1
      BEGIN
        SELECT RAISE(ABORT, 'forced onboarding failure');
      END
    `);

    expect(() => ownerABots.createBotWithinQuota(5)).toThrow(/forced onboarding failure/);
    expect(ownerABots.count()).toBe(0);
    expect(db.prepare<{ n: number }>("SELECT count(*) AS n FROM bots").get()?.n).toBe(0);
    expect(db.prepare<{ n: number }>("SELECT count(*) AS n FROM threads").get()?.n).toBe(0);
    expect(db.prepare<{ n: number }>("SELECT count(*) AS n FROM messages").get()?.n).toBe(0);
  });

  it("reports a handle collision without partial bot, thread, or onboarding writes", () => {
    const ownerId = db.prepare<{ id: string }>("SELECT id FROM users WHERE github_id = 101").get()!.id;
    const fixedHandle = "C".repeat(PUBLIC_BOT_HANDLE_LENGTH);
    const collisionRepos: Repositories = {
      ...repos,
      bots: createBotsRepository(db, { generatePublicHandle: () => fixedHandle }),
    };
    const collisionService = createBotsService({ repos: collisionRepos, defaultSelection: selection });
    const first = collisionService.forOwner(ownerId).createBot();
    expect(first.publicHandle).toBe(fixedHandle);
    expect(collisionService.forOwner(ownerId).deleteBot(first.id)).toBe(true);
    const before = {
      bots: db.prepare<{ n: number }>("SELECT count(*) AS n FROM bots").get()!.n,
      threads: db.prepare<{ n: number }>("SELECT count(*) AS n FROM threads").get()!.n,
      messages: db.prepare<{ n: number }>("SELECT count(*) AS n FROM messages").get()!.n,
    };

    expect(() => collisionService.forOwner(ownerId).createBotWithinQuota(5)).toThrow(/UNIQUE/i);
    expect(db.prepare<{ n: number }>("SELECT count(*) AS n FROM bots").get()!.n).toBe(before.bots);
    expect(db.prepare<{ n: number }>("SELECT count(*) AS n FROM threads").get()!.n).toBe(before.threads);
    expect(db.prepare<{ n: number }>("SELECT count(*) AS n FROM messages").get()!.n).toBe(before.messages);
    expect(db.prepare<{ n: number }>("SELECT count(*) AS n FROM public_bot_handles").get()!.n).toBe(1);
  });

  it("isolates group reads/hydration and rejects cross-owner membership injection", () => {
    const legacyBot = desktopBots.createBot();
    const botA = ownerABots.createBot();
    const secondA = ownerABots.createBot();
    const botB = ownerBBots.createBot();
    const legacyGroup = desktopGroups.createGroup("legacy", [legacyBot.id]);
    const groupA = ownerAGroups.createGroup("a-only", [botA.id], true);
    const groupB = ownerBGroups.createGroup("b-only", [botB.id], true);
    ownerABots.appendMessage(groupA.threadId, { role: "user", kind: "text", text: "group-a-private" });
    ownerBBots.appendMessage(groupB.threadId, { role: "user", kind: "text", text: "group-b-private" });

    expect(Object.keys(ownerAGroups)).not.toEqual(expect.arrayContaining(["forOwner", "repos"]));
    expect(ownerAGroups.list().map((group) => group.id)).toEqual([groupA.id]);
    expect(ownerAGroups.get(groupB.id)).toBeNull();
    expect(ownerAGroups.get(legacyGroup.id)).toBeNull();
    expect(ownerAGroups.byThread(groupB.threadId)).toBeNull();
    expect(ownerAGroups.publicGroup(groupB.id, { messages: 1 })).toBeNull();
    expect(ownerAGroups.publicGroup(legacyGroup.id)).toBeNull();
    expect(ownerAGroups.publicGroups({ messages: 1 })).toMatchObject([
      { id: groupA.id, messages: [{ text: "group-a-private" }] },
    ]);
    expect(ownerAGroups.dmGroup(botA.id, botB.id)).toBeNull();
    expect(ownerABots.pageMessages(groupB.threadId, { limit: 20 })).toMatchObject({ ok: false, status: 404 });

    const before = ownerAGroups.list();
    expect(() => ownerAGroups.createGroup("foreign", [botA.id, botB.id])).toThrow(/no such group member bot/);
    expect(() => ownerAGroups.createGroup("legacy", [legacyBot.id])).toThrow(/no such group member bot/);
    expect(() => ownerAGroups.patchGroup(groupA.id, { memberIds: [botA.id, botB.id] })).toThrow(
      /no such group member bot/,
    );
    expect(() => ownerAGroups.patchGroup(groupA.id, { memberIds: [legacyBot.id] })).toThrow(
      /no such group member bot/,
    );
    expect(ownerAGroups.patchGroup(groupB.id, { name: "stolen" })).toBeNull();
    expect(ownerAGroups.patchGroup(legacyGroup.id, { name: "claimed" })).toBeNull();
    expect(ownerAGroups.list()).toEqual(before);
    expect(desktopGroups.get(groupB.id)?.name).toBe("b-only");
    expect(desktopGroups.get(legacyGroup.id)?.name).toBe("legacy");

    expect(ownerAGroups.patchGroup(groupA.id, { name: "renamed", memberIds: [botA.id, secondA.id] })).toMatchObject({
      name: "renamed",
      memberIds: [botA.id, secondA.id],
    });
  });
});
