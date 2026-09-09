// #149 first slice — Telegram Allow once / Deny uses the existing permission
// broker. Fake Telegram API + fake driver. No sleeps. persistAllowRule is
// unchanged: Allow-once still writes nothing.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";

import { loadRules, persistAllowRule, WORKSPACE_SCOPE } from "./approvals.ts";
import { DATA_DIR } from "./config.ts";
import type { RuntimeEvent } from "./contracts.ts";
import { defaultDbPath, openDatabase } from "./db/database.ts";
import type { SqliteDatabase } from "./db/sqlite-native.ts";
import { EventBus } from "./harness/bus.ts";
import { ProviderRegistry } from "./harness/registry.ts";
import { createComputerRegistry } from "./computer/registry.ts";
import { createProactive } from "./proactive.ts";
import { createRepositories, type Repositories } from "./repositories/index.ts";
import { createBotsService, type BotsService } from "./services/bots.ts";
import { createTeachService } from "./services/teach.ts";
import { createTurnsService, type TurnsService } from "./services/turns.ts";
import { createRoutinesService, type RoutinesService } from "./services/routines.ts";
import { makeFakeDriver } from "./testing/fake-driver.ts";
import { createTelegramService, type TelegramService } from "./telegram.ts";
import type { TelegramApi, TelegramApiUpdate, TelegramSendOptions } from "./telegram-api.ts";
import { TELEGRAM_ALLOW_ONCE_LABEL, TELEGRAM_APPROVAL_TTL_MS, TELEGRAM_DENY_LABEL } from "./telegram-approvals.ts";

const TOOL = "shell";
const SUMMARY = "git status";

function telegramToken(): string {
  return `${123456789}:${"A".repeat(35)}`;
}

function opened(threadId: string, requestId: string): RuntimeEvent {
  return {
    eventId: `ev-${requestId}`,
    provider: "fake",
    providerInstanceId: "fake",
    threadId,
    createdAt: new Date().toISOString(),
    type: "request.opened",
    requestType: "permission",
    tool: TOOL,
    summary: SUMMARY,
    requestId,
  };
}

describe("telegram approval broker path", () => {
  let db: SqliteDatabase;
  let repos: Repositories;
  let bots: BotsService;
  let turns: TurnsService;
  let bus: EventBus;
  let telegram: TelegramService;
  let now: number;
  let sent: Array<{ chatId: string; text: string; replyMarkup?: TelegramSendOptions["replyMarkup"] }>;
  let edited: Array<{ text: string }>;
  let respondCalls: Array<{ threadId: string; requestId: string; behavior?: string; always?: boolean }>;
  let sendError: Error | null;
  let startTurns: string[];

  const selection = () => ({ instanceId: "fake", model: "fake-1" });

  function card(threadId: string) {
    return bots.messagesFor(threadId).find((m) => m.kind === "options" && m.card?.requestId);
  }

  async function flush() {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  }

  function callback(data: string, userId = 111, chatId = 111): TelegramApiUpdate {
    return {
      update_id: 40,
      callback_query: {
        id: "cq-broker",
        from: { id: userId },
        message: { message_id: 1, chat: { id: chatId } },
        data,
      },
    };
  }

  beforeEach(async () => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    db = openDatabase(defaultDbPath());
    repos = createRepositories(db);
    now = 2_000_000;
    sent = [];
    edited = [];
    respondCalls = [];
    sendError = null;
    startTurns = [];

    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ fake: { driver: "fake", displayName: "Fake" } });
    const live = fake.created.get("fake")!;
    live.instance.adapter.sendTurn = async () => ({ turnId: "fake-turn" });
    live.instance.adapter.respondToRequest = async (threadId, requestId, body) => {
      respondCalls.push({
        threadId,
        requestId,
        behavior: body.behavior,
        always: body.always,
      });
      bus.publish({
        eventId: `ev-res-${requestId}`,
        provider: "fake",
        providerInstanceId: "fake",
        threadId,
        createdAt: new Date().toISOString(),
        type: "request.resolved",
        behavior: String(body.behavior ?? ""),
        source: "user",
        requestId,
      });
    };

    bus = new EventBus();
    bus.attach(registry.instances());
    bots = createBotsService({ repos, defaultSelection: selection });
    const computers = await createComputerRegistry({ cfg: { computer: { providers: {} } } });
    const teach = createTeachService({
      bus,
      registry,
      bot: (id) => bots.bot(id),
      patchBot: (id, patch) => bots.patchBot(id, patch),
    });
    const proactive = createProactive({ now: () => now, onNudge: () => {}, onTrigger: () => {} });
    let routinesRef: RoutinesService | null = null;
    let telegramRef: TelegramService | null = null;
    turns = createTurnsService({
      cfg: { instances: { fake: { driver: "fake" } } },
      registry,
      computers,
      bus,
      repos,
      bots,
      routines: () => routinesRef!,
      teach,
      proactive,
      broadcast: (payload) => telegramRef?.onBroadcast(payload),
      port: 0,
      commsToken: "test-telegram-approval",
      now: () => now,
      onPermissionApproval: (input) => telegramRef?.notifyPermissionApproval(input),
    });
    routinesRef = createRoutinesService({
      repos,
      now: () => now,
      broadcast: () => {},
      bot: (id) => {
        const b = bots.bot(id);
        return b ? { id: b.id, threadId: b.threadId, busy: b.busy, hidden: b.hidden === true } : null;
      },
      startTurn: (botId, text) => {
        startTurns.push(text);
        return turns.startTurn(botId, text);
      },
      getSkill: () => null,
      skillPrompt: (_s, p) => p,
    });
    const api: TelegramApi = {
      async getUpdates() {
        return [];
      },
      async sendMessage(_token, chatId, text, options) {
        if (sendError) throw sendError;
        sent.push({ chatId, text, replyMarkup: options?.replyMarkup });
        return { messageId: sent.length };
      },
      async editMessageText(_token, _chatId, _messageId, text) {
        edited.push({ text });
      },
      async answerCallbackQuery() {},
    };
    const agent = bots.createBot();
    bots.patchBot(agent.id, { name: "Scout", computer: "off" });
    telegram = createTelegramService({
      cfg: () => ({
        telegram: {
          token: telegramToken(),
          enabled: true,
          defaultBotId: agent.id,
          allowlist: ["111"],
        },
      }),
      api,
      conversations: repos.telegramConversations,
      bots,
      startTurn: async (botId, text) => {
        startTurns.push(text);
        return turns.startTurn(botId, text);
      },
      now: () => now,
      answerPermission: (botId, requestId, behavior) => turns.respond(botId, requestId, { behavior }),
      markPermissionTerminal: (botId, requestId, answered) => {
        const bot = bots.bot(botId);
        if (!bot) return;
        const existing = bots.messagesFor(bot.threadId).find((msg) => msg.card?.requestId === requestId);
        if (!existing?.card || existing.card.answered) return;
        bots.patchMessage(bot.threadId, existing.id, { card: { ...existing.card, answered } });
      },
    });
    telegramRef = telegram;
  });

  afterEach(() => {
    telegram.stop();
    try {
      db.close();
    } catch {
      /* already closed */
    }
  });

  it("Allow once uses the existing broker (always not true) and persistAllowRule writes nothing", async () => {
    const bot = bots.bots()[0]!;
    repos.telegramConversations.upsert({
      chatId: "111",
      userId: "111",
      botId: bot.id,
      threadId: bot.threadId,
      now,
    });
    bus.publish(opened(bot.threadId, "req-once"));
    await flush();
    const pending = card(bot.threadId);
    expect(pending?.card?.options).toEqual(["Allow once", "Deny"]);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.chatId).toBe("111");
    const labels = sent[0]?.replyMarkup?.inline_keyboard.flat().map((btn) => btn.text);
    expect(labels).toEqual([TELEGRAM_ALLOW_ONCE_LABEL, TELEGRAM_DENY_LABEL]);
    const beforeTurns = startTurns.length;
    const allow = sent[0]!.replyMarkup!.inline_keyboard[0]![0]!.callback_data;
    await telegram.handleUpdate(callback(allow));
    expect(respondCalls).toEqual([{ threadId: bot.threadId, requestId: "req-once", behavior: "allow", always: false }]);
    expect(loadRules(bot.id)).toEqual([]);
    expect(loadRules(WORKSPACE_SCOPE)).toEqual([]);
    expect(persistAllowRule({
      botId: bot.id,
      tool: TOOL,
      summary: SUMMARY,
      behavior: "allow",
      always: false,
    })).toBeNull();
    expect(card(bot.threadId)?.card?.answered).toBe("allow");
    expect(edited.at(-1)?.text).toMatch(/Decision: Allow once/);
    expect(startTurns.length).toBe(beforeTurns);
  });

  it("Deny denies on the same broker path and does not start a second turn", async () => {
    const bot = bots.bots()[0]!;
    repos.telegramConversations.upsert({
      chatId: "111",
      userId: "111",
      botId: bot.id,
      threadId: bot.threadId,
      now,
    });
    bus.publish(opened(bot.threadId, "req-deny"));
    await flush();
    const beforeTurns = startTurns.length;
    const deny = sent[0]!.replyMarkup!.inline_keyboard[0]![1]!.callback_data;
    await telegram.handleUpdate(callback(deny));
    expect(respondCalls).toEqual([{ threadId: bot.threadId, requestId: "req-deny", behavior: "deny", always: false }]);
    expect(card(bot.threadId)?.card?.answered).toBe("deny");
    expect(loadRules(bot.id)).toEqual([]);
    expect(startTurns.length).toBe(beforeTurns);
  });

  it("replay is a no-op and both surfaces keep the same terminal state", async () => {
    const bot = bots.bots()[0]!;
    repos.telegramConversations.upsert({
      chatId: "111",
      userId: "111",
      botId: bot.id,
      threadId: bot.threadId,
      now,
    });
    bus.publish(opened(bot.threadId, "req-replay"));
    await flush();
    const allow = sent[0]!.replyMarkup!.inline_keyboard[0]![0]!.callback_data;
    const deny = sent[0]!.replyMarkup!.inline_keyboard[0]![1]!.callback_data;
    await telegram.handleUpdate(callback(allow));
    expect(respondCalls).toHaveLength(1);
    expect(card(bot.threadId)?.card?.answered).toBe("allow");
    expect(edited.at(-1)?.text).toMatch(/Decision: Allow once/);

    await telegram.handleUpdate(callback(deny, 111, 111));
    const afterReplay = await turns.respond(bot.id, "req-replay", { behavior: "deny" });
    expect(afterReplay).toEqual({ ok: true });
    expect(respondCalls).toHaveLength(1);
    expect(respondCalls[0]).toMatchObject({ behavior: "allow", always: false });
    expect(card(bot.threadId)?.card?.answered).toBe("allow");
    expect(edited.at(-1)?.text).toMatch(/Decision: Allow once/);
    expect(edited.at(-1)?.text).not.toMatch(/Deny|expired/i);
    expect(loadRules(bot.id)).toEqual([]);
  });

  it("expired callback does not approve; Telegram and the desktop card both show expired", async () => {
    const bot = bots.bots()[0]!;
    repos.telegramConversations.upsert({
      chatId: "111",
      userId: "111",
      botId: bot.id,
      threadId: bot.threadId,
      now,
    });
    bus.publish(opened(bot.threadId, "req-exp"));
    await flush();
    expect(card(bot.threadId)?.card?.answered).toBeUndefined();
    const allow = sent[0]!.replyMarkup!.inline_keyboard[0]![0]!.callback_data;
    now += TELEGRAM_APPROVAL_TTL_MS;
    await telegram.handleUpdate(callback(allow));
    expect(respondCalls).toEqual([]);
    expect(card(bot.threadId)?.card?.answered).toBe("expired");
    expect(edited.at(-1)?.text).toMatch(/expired/i);
    expect(edited.at(-1)?.text).not.toMatch(/Decision: Allow once/);

    const late = await turns.respond(bot.id, "req-exp", { behavior: "allow" });
    expect(late).toEqual({ ok: true });
    expect(respondCalls).toEqual([]);
    expect(card(bot.threadId)?.card?.answered).toBe("expired");
    expect(edited.at(-1)?.text).toMatch(/expired/i);
    expect(loadRules(bot.id)).toEqual([]);
  });

  it("leaves the desktop card usable when Telegram send throws", async () => {
    const bot = bots.bots()[0]!;
    repos.telegramConversations.upsert({
      chatId: "111",
      userId: "111",
      botId: bot.id,
      threadId: bot.threadId,
      now,
    });
    sendError = new Error("Could not reach api.telegram.org (ECONNREFUSED). Check your network.");
    bus.publish(opened(bot.threadId, "req-desk"));
    await flush();
    expect(sent).toEqual([]);
    expect(card(bot.threadId)?.card?.answered).toBeUndefined();
    const result = await turns.respond(bot.id, "req-desk", { behavior: "allow" });
    expect(result).toEqual({ ok: true });
    expect(respondCalls).toEqual([{ threadId: bot.threadId, requestId: "req-desk", behavior: "allow", always: false }]);
    expect(loadRules(bot.id)).toEqual([]);
    expect(card(bot.threadId)?.card?.answered).toBe("allow");
  });
});
