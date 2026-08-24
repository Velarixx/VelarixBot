import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { DATA_DIR, loadConfig, saveConfig, type AppConfig } from "./config.ts";
import { defaultDbPath, openDatabase } from "./db/database.ts";
import type { SqliteDatabase } from "./db/sqlite-native.ts";
import { createRepositories, type Repositories } from "./repositories/index.ts";
import { createBotsService, type BotsService } from "./services/bots.ts";
import { createGroupsService, type GroupsService } from "./services/groups.ts";
import { createFakeDiscordGateway, createFakeDiscordRest } from "./channels/discord.ts";
import { createDiscordService, DISCORD_COPY, discordSafeText, type DiscordService } from "./discord.ts";
import { isDiscordAuthorized, parseAllowlists } from "./channels/discord-protocol.ts";
import { resolveApprovalsForChannelEvent } from "./channels/contracts.ts";
import { secretStore } from "./secrets.ts";

const selection = () => ({ instanceId: "claude", model: "claude-sonnet-5" });

function canary(tag: string): string {
  return ["fake", tag, "canary", Date.now().toString(36), Math.random().toString(36).slice(2)].join("-");
}

describe("discord allowlist helpers", () => {
  it("denies everyone when the allowlist is empty", () => {
    const empty = parseAllowlists({});
    expect(isDiscordAuthorized(empty, { channelId: "1", userId: "1" })).toBe(false);
  });
});

describe("discord service", () => {
  let db: SqliteDatabase;
  let repos: Repositories;
  let bots: BotsService;
  let groups: GroupsService;
  let cfg: AppConfig;
  let turns: Array<{ botId: string; text: string; unattended?: boolean; groupThreadId?: string; idempotencyKey?: string; requestId?: string }>;
  let gateway: ReturnType<typeof createFakeDiscordGateway>;
  let rest: ReturnType<typeof createFakeDiscordRest>;
  let discord: DiscordService;

  beforeEach(async () => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    db = openDatabase(defaultDbPath());
    repos = createRepositories(db);
    bots = createBotsService({ repos, defaultSelection: selection });
    groups = createGroupsService({ repos });
    const agent = bots.createBot();
    bots.patchBot(agent.id, { name: "Scout" });
    const token = canary("discord");
    cfg = {
      discord: {
        token,
        enabled: true,
        defaultBotId: agent.id,
        guildAllowlist: ["10"],
        channelAllowlist: ["20"],
        userAllowlist: ["30"],
      },
    };
    turns = [];
    gateway = createFakeDiscordGateway();
    rest = createFakeDiscordRest();
    let resolveConnected: (() => void) | undefined;
    const connected = new Promise<void>((resolve) => {
      resolveConnected = resolve;
    });
    discord = createDiscordService({
      cfg: () => cfg,
      conversations: repos.discordConversations,
      bots,
      groups,
      startTurn: async (botId, text, opts) => {
        turns.push({
          botId,
          text,
          unattended: opts?.unattended,
          groupThreadId: opts?.groupThreadId,
          idempotencyKey: opts?.idempotencyKey,
          requestId: opts?.requestId,
        });
        return { threadId: bots.bot(botId)!.threadId, messageId: "m1" };
      },
      now: () => 1_700_000_000_000,
      connectOpts: () => ({
        transport: gateway.transport,
        rest,
        scheduler: { every() { return () => {}; } },
      }),
      onStatusChange: () => {
        if (discord.publicStatus().status === "connected") resolveConnected?.();
      },
    });
    discord.applyConfig();
    await gateway.whenConnected();
    gateway.hello();
    gateway.ready({ id: "bot-9", bot: true });
    await connected;
  });

  afterEach(() => {
    discord.stop();
    try {
      db.close();
    } catch {
      /* already closed */
    }
  });

  async function inbound(input: { text: string; userId?: string; channelId?: string; guildId?: string; id?: string }) {
    await discord.handleInbound({
      id: input.id ?? `msg-${turns.length + 1}`,
      connectorId: "discord",
      address: {
        connectorId: "discord",
        kind: "discord",
        target: `${input.guildId ?? "10"}/${input.channelId ?? "20"}`,
      },
      sender: { connectorId: "discord", nativeId: input.userId ?? "30", handle: "ada" },
      text: input.text,
      attachments: [],
      createdAt: "2026-08-24T00:00:00.000Z",
    });
  }

  it("rejects an unauthorized user without starting a turn or persisting a binding", async () => {
    await inbound({ text: "show me the secret transcript", userId: "999", channelId: "999", guildId: "999" });
    expect(turns).toEqual([]);
    expect(repos.discordConversations.getByKey("999/999")).toBeNull();
    const unauthorized = rest.sent.find((row) => typeof (row.body as { content?: string })?.content === "string");
    expect((unauthorized?.body as { content?: string })?.content).toBe(DISCORD_COPY.unauthorized);
  });

  it("binds inbound conversations to the configured agent and starts an unattended turn", async () => {
    const scout = bots.bots()[0]!;
    await inbound({ text: "from discord", id: "in-1" });
    expect(turns).toEqual([
      {
        botId: scout.id,
        text: "from discord",
        unattended: true,
        groupThreadId: undefined,
        idempotencyKey: "channel:discord:in-1",
        requestId: undefined,
      },
    ]);
    expect(repos.discordConversations.getByKey("10/20")).toMatchObject({
      botId: scout.id,
      velarixThreadId: scout.threadId,
    });
    const inboundMessage = {
      id: "in-1",
      connectorId: "discord",
      address: { connectorId: "discord", kind: "discord", target: "10/20" },
      sender: { connectorId: "discord", nativeId: "30" },
      text: "from discord",
      attachments: [],
      createdAt: "2026-08-24T00:00:00.000Z",
    };
    expect(resolveApprovalsForChannelEvent(inboundMessage)).toBeNull();
  });

  it("does not let a Discord user pick another local agent", async () => {
    const scout = bots.bots()[0]!;
    const helper = bots.createBot();
    bots.patchBot(helper.id, { name: "Helper" });
    await inbound({ text: "talk to Helper instead", id: "switch" });
    expect(turns).toEqual([
      {
        botId: scout.id,
        text: "talk to Helper instead",
        unattended: true,
        groupThreadId: undefined,
        idempotencyKey: "channel:discord:switch",
        requestId: undefined,
      },
    ]);
    expect(repos.discordConversations.getByKey("10/20")?.botId).toBe(scout.id);
    expect(repos.discordConversations.getByKey("10/20")?.botId).not.toBe(helper.id);
  });

  it("does not persist a conversation for an empty allowlist", async () => {
    cfg.discord = { ...cfg.discord, guildAllowlist: [], channelAllowlist: [], userAllowlist: [] };
    await discord.applyConfig();
    await inbound({ text: "hello" });
    expect(turns).toEqual([]);
    expect(repos.discordConversations.getByKey("10/20")).toBeNull();
    expect(discord.publicStatus().statusMessage).toMatch(/allowlist is empty/i);
  });

  it("drops the token from SecretStore immediately on disconnectNow", async () => {
    const token = cfg.discord!.token!;
    await saveConfig({ discord: { token, enabled: true } });
    expect(secretStore().has("discord.token")).toBe(true);
    discord.disconnectNow();
    expect(secretStore().has("discord.token")).toBe(false);
    expect(discord.publicStatus()).toMatchObject({ configured: false, enabled: false, status: "disconnected" });
    expect(JSON.stringify(discord.publicStatus())).not.toContain(token);
  });

  it("never sends secrets over Discord broadcasts", async () => {
    const scout = bots.bots()[0]!;
    const token = cfg.discord!.token!;
    await inbound({ text: "go" });
    rest.sent.length = 0;
    discord.onBroadcast({
      kind: "message",
      threadId: scout.threadId,
      message: { kind: "text", role: "bot", text: `here is ${token}` },
    });
    await Promise.resolve();
    const outbound = rest.sent.map((row) => JSON.stringify(row.body)).join("\n");
    expect(outbound).not.toContain(token);
    expect(discordSafeText(`token=${canary("secret")}`)).toContain("[redacted]");
  });
});

describe("discord config status after a sealed save", () => {
  it("GET-shaped status never echoes the token", async () => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    const token = canary("discord");
    await saveConfig({
      discord: { token, enabled: false, guildAllowlist: ["10"], channelAllowlist: [], userAllowlist: [] },
    });
    const cfg = loadConfig();
    expect(cfg.discord?.token).toBe(token);
    const disk = JSON.parse(readFileSync(join(DATA_DIR, "config.json"), "utf8"));
    expect(disk.discord.token).toBe("secret://discord.token");
    expect(JSON.stringify({ configured: Boolean(cfg.discord?.token) })).not.toContain(token);
  });
});
