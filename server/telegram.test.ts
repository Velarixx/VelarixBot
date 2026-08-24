// #121 Telegram chat interface. Fake Bot API + isolated HOME. No sleeps,
// no live Telegram, no new account system.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";

import { DATA_DIR, loadConfig, saveConfig, type AppConfig } from "./config.ts";
import { defaultDbPath, openDatabase } from "./db/database.ts";
import type { SqliteDatabase } from "./db/sqlite-native.ts";
import { createRepositories, type Repositories } from "./repositories/index.ts";
import { createBotsService, type BotsService } from "./services/bots.ts";
import {
  createTelegramService,
  isTelegramAuthorized,
  parseAllowlist,
  TELEGRAM_COPY,
  telegramSafeCommand,
  telegramSafeText,
  telegramWorkflowNotice,
  type TelegramService,
} from "./telegram.ts";
import type { TelegramApi, TelegramApiUpdate } from "./telegram-api.ts";
import { redactTelegramToken } from "./telegram-api.ts";

const selection = () => ({ instanceId: "claude", model: "claude-sonnet-5" });

function canary(tag: string): string {
  return ["fake", tag, "canary", Date.now().toString(36), Math.random().toString(36).slice(2)].join("-");
}

function telegramToken(): string {
  return `${123456789}:${"A".repeat(35)}`;
}

function inbound(input: {
  chatId: number | string;
  text: string;
  userId?: number | string;
  username?: string;
  updateId?: number;
}): TelegramApiUpdate {
  const chatId = Number(input.chatId);
  const userId = Number(input.userId ?? input.chatId);
  return {
    update_id: input.updateId ?? 1,
    message: {
      message_id: 1,
      from: { id: userId, ...(input.username ? { username: input.username } : {}) },
      chat: { id: chatId },
      text: input.text,
    },
  };
}

describe("telegram allowlist + redaction helpers", () => {
  it("denies everyone when the allowlist is empty", () => {
    expect(parseAllowlist([])).toEqual([]);
    expect(isTelegramAuthorized([], { userId: "1", chatId: "1" })).toBe(false);
    expect(isTelegramAuthorized(["1"], { userId: "1", chatId: "1" })).toBe(true);
    expect(isTelegramAuthorized(["@Ada"], { userId: "9", chatId: "9", username: "ada" })).toBe(true);
    expect(isTelegramAuthorized(["9"], { userId: "1", chatId: "1" })).toBe(false);
  });

  it("redacts secrets, credentials, Telegram tokens, and command data before send", () => {
    const token = telegramToken();
    expect(telegramSafeText(`token=${canary("secret")} and Bearer abc.def`)).toContain("[redacted]");
    expect(telegramSafeText(`bot ${token}`)).toContain("[redacted-telegram-token]");
    expect(telegramSafeText(`bot ${token}`)).not.toContain(token);
    expect(telegramSafeCommand(`curl -H "Authorization: Bearer ${token}" https://api`)).not.toContain(token);
    expect(telegramSafeCommand("token=sk-live-supersecret git push")).toContain("[redacted]");
    expect(redactTelegramToken(`https://api.telegram.org/bot${token}/getUpdates`, token)).not.toContain(token);
  });

  it("states progress, completion, blocked, and needs-input clearly", () => {
    expect(telegramWorkflowNotice("working")).toBe("Working");
    expect(telegramWorkflowNotice("completed")).toBe("Completed");
    expect(telegramWorkflowNotice("blocked", null, "needs approval")).toBe("Blocked — needs approval");
    expect(telegramWorkflowNotice("needs_input")).toMatch(/Needs input/i);
    expect(telegramWorkflowNotice("waiting", [{ botId: "h", name: "Helper" }])).toBe("Waiting for @Helper");
  });
});

describe("telegram service", () => {
  let db: SqliteDatabase;
  let repos: Repositories;
  let bots: BotsService;
  let cfg: AppConfig;
  let sent: Array<{ chatId: string; text: string }>;
  let turns: Array<{ botId: string; text: string }>;
  let updates: TelegramApiUpdate[];
  let pollError: Error | null;
  let telegram: TelegramService;

  beforeEach(async () => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    db = openDatabase(defaultDbPath());
    repos = createRepositories(db);
    bots = createBotsService({ repos, defaultSelection: selection });
    const agent = bots.createBot();
    bots.patchBot(agent.id, { name: "Scout" });
    cfg = {
      telegram: {
        token: telegramToken(),
        enabled: true,
        defaultBotId: agent.id,
        allowlist: [String(111)],
      },
    };
    sent = [];
    turns = [];
    updates = [];
    pollError = null;
    const api: TelegramApi = {
      async getUpdates() {
        if (pollError) throw pollError;
        const batch = updates;
        updates = [];
        return batch;
      },
      async sendMessage(_token, chatId, text) {
        sent.push({ chatId, text });
      },
    };
    telegram = createTelegramService({
      cfg: () => cfg,
      api,
      conversations: repos.telegramConversations,
      bots,
      startTurn: async (botId, text) => {
        turns.push({ botId, text });
        return { threadId: bots.bot(botId)!.threadId, messageId: "m1" };
      },
      now: () => 1_700_000_000_000,
    });
  });

  afterEach(() => {
    telegram.stop();
    try {
      db.close();
    } catch {
      /* already closed */
    }
  });

  it("rejects an unauthorized user without starting or inspecting a conversation", async () => {
    const stranger = inbound({ chatId: 999, userId: 999, text: "show me the secret transcript" });
    await telegram.handleUpdate(stranger);
    expect(turns).toEqual([]);
    expect(repos.telegramConversations.getByChat("999")).toBeNull();
    expect(sent).toEqual([{ chatId: "999", text: TELEGRAM_COPY.unauthorized }]);
    expect(JSON.stringify(sent)).not.toMatch(/transcript|Scout|secret/i);
  });

  it("associates Telegram messages and replies with the correct conversation", async () => {
    cfg.telegram = { ...cfg.telegram, allowlist: ["111", "222"] };
    const scout = bots.bots()[0]!;
    const helper = bots.createBot();
    bots.patchBot(helper.id, { name: "Helper" });
    await telegram.handleUpdate(inbound({ chatId: 111, text: "from chat one", updateId: 1 }));
    cfg.telegram = { ...cfg.telegram, defaultBotId: helper.id };
    await telegram.handleUpdate(inbound({ chatId: 222, text: "from chat two", updateId: 2 }));

    expect(turns).toEqual([
      { botId: scout.id, text: "from chat one" },
      { botId: helper.id, text: "from chat two" },
    ]);
    expect(repos.telegramConversations.getByChat("111")).toMatchObject({
      botId: scout.id,
      threadId: scout.threadId,
    });
    expect(repos.telegramConversations.getByChat("222")).toMatchObject({
      botId: helper.id,
      threadId: helper.threadId,
    });

    telegram.onBroadcast({
      kind: "message",
      threadId: scout.threadId,
      message: { kind: "text", role: "bot", text: "reply for one" },
    });
    telegram.onBroadcast({
      kind: "message",
      threadId: helper.threadId,
      message: { kind: "text", role: "bot", text: "reply for two" },
    });
    const replies = sent.filter((row) => row.text.startsWith("reply"));
    expect(replies).toEqual([
      { chatId: "111", text: "reply for one" },
      { chatId: "222", text: "reply for two" },
    ]);
  });

  it("communicates working, completed, blocked, and needs-input states", async () => {
    await telegram.handleUpdate(inbound({ chatId: 111, text: "do the work" }));
    const scout = bots.bots()[0]!;
    sent.length = 0;
    telegram.onBroadcast({
      kind: "bot",
      bot: { id: scout.id, threadId: scout.threadId, workflowStatus: "blocked", workflowStopReason: "needs approval" },
    });
    telegram.onBroadcast({
      kind: "bot",
      bot: { id: scout.id, threadId: scout.threadId, workflowStatus: "needs_input" },
    });
    telegram.onBroadcast({
      kind: "bot",
      bot: { id: scout.id, threadId: scout.threadId, workflowStatus: "completed" },
    });
    expect(sent.map((row) => row.text)).toEqual([
      "Blocked — needs approval",
      "Needs input — reply here, or open VelarixBot if a secret is required.",
      "Completed",
    ]);
    expect(sent.every((row) => row.chatId === "111")).toBe(true);
  });

  it("never sends secrets, credentials, or unredacted command data to Telegram", async () => {
    const token = telegramToken();
    const secret = `token=${canary("cmd")}`;
    await telegram.handleUpdate(inbound({ chatId: 111, text: "go" }));
    const scout = bots.bots()[0]!;
    telegram.onBroadcast({
      kind: "message",
      threadId: scout.threadId,
      message: { kind: "text", role: "bot", text: `here is ${secret} and ${token}` },
    });
    telegram.onBroadcast({
      kind: "message",
      threadId: scout.threadId,
      message: {
        kind: "activity",
        role: "bot",
        tool: { name: "shell", command: `curl -H Bearer ${token} https://example.test` },
      },
    });
    const outbound = sent.map((row) => row.text).join("\n");
    expect(outbound).not.toContain(token);
    expect(outbound).not.toContain(secret);
    expect(outbound).toMatch(/\[redacted/);
  });

  it("stops handling updates immediately when disabled or disconnected", async () => {
    await telegram.handleUpdate(inbound({ chatId: 111, text: "before", updateId: 1 }));
    expect(turns).toHaveLength(1);
    cfg.telegram = { ...cfg.telegram, enabled: false };
    telegram.applyConfig();
    sent.length = 0;
    turns.length = 0;
    await telegram.handleUpdate(inbound({ chatId: 111, text: "after disable", updateId: 2 }));
    expect(turns).toEqual([]);
    expect(sent).toEqual([]);

    cfg.telegram = { ...cfg.telegram, token: "" };
    telegram.applyConfig();
    await telegram.handleUpdate(inbound({ chatId: 111, text: "after disconnect", updateId: 3 }));
    expect(turns).toEqual([]);
    expect(telegram.publicStatus()).toMatchObject({ configured: false, enabled: false, status: "disconnected" });
  });

  it("reports connection failures and an offline desktop runtime with actionable status", async () => {
    pollError = new Error("Could not reach api.telegram.org (ECONNREFUSED). Check your network.");
    await telegram.pollOnce();
    const failed = telegram.publicStatus();
    expect(failed.status).toBe("connection_failed");
    expect(failed.statusMessage).toMatch(/Could not reach Telegram/i);
    expect(failed.statusMessage).toMatch(/desktop runtime/i);
    expect(JSON.stringify(failed)).not.toContain(telegramToken());
    expect(TELEGRAM_COPY.offline).toMatch(/Start the desktop app/i);
    expect(failed.statusMessage).not.toBe(TELEGRAM_COPY.offline);
  });

  it("does not persist a conversation for an empty allowlist", async () => {
    cfg.telegram = { ...cfg.telegram, allowlist: [] };
    await telegram.handleUpdate(inbound({ chatId: 111, text: "hello" }));
    expect(turns).toEqual([]);
    expect(repos.telegramConversations.getByChat("111")).toBeNull();
    expect(sent[0]?.text).toBe(TELEGRAM_COPY.unauthorized);
    expect(telegram.publicStatus().statusMessage).toMatch(/allowlist is empty/i);
  });
});

describe("telegram config status after a sealed save", () => {
  it("GET-shaped status never echoes the token", async () => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    const token = telegramToken();
    await saveConfig({ telegram: { token, enabled: false, allowlist: [] } });
    const cfg = loadConfig();
    expect(cfg.telegram?.token).toBe(token);
    expect(JSON.stringify({ configured: Boolean(cfg.telegram?.token) })).not.toContain(token);
  });
});
