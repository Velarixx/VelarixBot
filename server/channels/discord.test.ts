import { describe, expect, it } from "vitest";

import { recordChannelEvents } from "../testing/channel-conformance.ts";
import { CHANNEL_EVENTS_INHERIT_STANDING_APPROVALS, resolveApprovalsForChannelEvent } from "./contracts.ts";
import {
  DiscordChannelFactory,
  createDiscordChannelConnector,
  createFakeDiscordGateway,
  createFakeDiscordRest,
  decodeDiscordChannelConfig,
  formatDiscordAddress,
  parseDiscordAddress,
} from "./discord.ts";
import { DISCORD_GATEWAY_INTENTS, isDiscordAuthorized, resolveDiscordBinding, splitDiscordText } from "./discord-protocol.ts";

function canary(): string {
  return ["fake", "discord", "canary", Date.now().toString(36), Math.random().toString(36).slice(2)].join("-");
}

function manualScheduler(): { scheduler: { every(ms: number, fn: () => void): () => void }; tick(): void } {
  let beat: (() => void) | null = null;
  return {
    scheduler: {
      every(_ms, fn) {
        beat = fn;
        return () => {
          beat = null;
        };
      },
    },
    tick() {
      beat?.();
    },
  };
}

async function connectLive(opts?: { guilds?: string[]; channels?: string[]; users?: string[] }) {
  const gateway = createFakeDiscordGateway();
  const rest = createFakeDiscordRest();
  const token = canary();
  const { scheduler, tick } = manualScheduler();
  const connector = createDiscordChannelConnector({
    id: "discord",
    config: {
      enabled: true,
      guildAllowlist: opts?.guilds ?? ["10"],
      channelAllowlist: opts?.channels ?? ["20"],
      userAllowlist: opts?.users ?? ["30"],
    },
  });
  const connecting = connector.connect({ token, transport: gateway.transport, rest, scheduler });
  await gateway.whenConnected();
  gateway.hello(60_000);
  gateway.ready({ id: "bot-9", username: "velarix", bot: true }, "sess-1", 1);
  await connecting;
  return { connector, gateway, rest, token, tick };
}

describe("discord protocol helpers", () => {
  it("denies everyone when every allowlist is empty", () => {
    const empty = { guilds: [], channels: [], users: [] };
    expect(isDiscordAuthorized(empty, { channelId: "20", userId: "30", guildId: "10" })).toBe(false);
    expect(isDiscordAuthorized({ guilds: ["10"], channels: [], users: [] }, { channelId: "20", userId: "30", guildId: "10" })).toBe(true);
    expect(isDiscordAuthorized({ guilds: [], channels: ["20"], users: [] }, { channelId: "20", userId: "30" })).toBe(true);
    expect(isDiscordAuthorized({ guilds: [], channels: [], users: ["@Ada"] }, { channelId: "9", userId: "9", username: "ada" })).toBe(true);
    expect(isDiscordAuthorized({ guilds: ["10"], channels: [], users: [] }, { channelId: "20", userId: "30", guildId: "99" })).toBe(false);
    const bindings = [
      { guildId: "10", channelId: "20", threadId: "99", botId: "thread-bot" },
      { guildId: "10", channelId: "20", botId: "channel-bot" },
      { guildId: "10", botId: "guild-bot" },
    ];
    expect(resolveDiscordBinding(bindings, { guildId: "10", channelId: "20", threadId: "99" })?.botId).toBe("thread-bot");
    expect(resolveDiscordBinding(bindings, { guildId: "10", channelId: "20" })?.botId).toBe("channel-bot");
    expect(resolveDiscordBinding(bindings, { guildId: "10", channelId: "other" })?.botId).toBe("guild-bot");
  });

  it("splits outbound text on the 2000-character Discord limit", () => {
    expect(splitDiscordText("short")).toEqual(["short"]);
    const long = `${"a".repeat(1990)}\n${"b".repeat(20)}`;
    const chunks = splitDiscordText(long);
    expect(chunks).toHaveLength(2);
    expect(chunks.every((chunk) => chunk.length <= 2000)).toBe(true);
    expect(chunks.join("").replace(/\n/g, "")).toBe(`${"a".repeat(1990)}${"b".repeat(20)}`);
  });
});

describe("discord channel connector", () => {
  it("parses and formats thread-aware discord: addresses without touching the network", () => {
    const address = parseDiscordAddress("discord:10/20/30", "discord");
    expect(address).toEqual({
      connectorId: "discord",
      kind: "discord",
      target: "10/20/30",
      display: "discord:10/20/30",
    });
    expect(formatDiscordAddress(address)).toBe("discord:10/20/30");
    expect(() => parseDiscordAddress("", "discord")).toThrow(/address/);
    expect(() => parseDiscordAddress("fake:inbox", "discord")).toThrow(/scheme/);
  });

  it("rejects a token in connector config and stays disconnected until connect()", async () => {
    expect(() => decodeDiscordChannelConfig({ token: "anything" })).toThrow(/SecretStore/);
    expect(() => decodeDiscordChannelConfig("x")).toThrow(/must be an object/);
    const created = await DiscordChannelFactory.create({
      id: "discord-2",
      config: { guildAllowlist: ["1"] },
    });
    expect(created.id).toBe("discord-2");
    expect(created.capabilities).toEqual({ send: true, receive: true, reactions: true, receipts: true });
    expect(created.status()).toMatchObject({ configured: false, enabled: false, status: "disconnected" });
  });

  it("identifies with explicit intents, tracks heartbeat sequence, and resumes", async () => {
    const { connector, gateway, token, tick } = await connectLive();
    expect(gateway.lastIdentify()).toMatchObject({ token, intents: DISCORD_GATEWAY_INTENTS });
    expect(JSON.stringify(connector.status())).not.toContain(token);
    tick();
    expect(gateway.lastHeartbeat()).toBe(1);
    gateway.dispatch("MESSAGE_CREATE", {
      id: "m-seq",
      content: "hello",
      channel_id: "20",
      guild_id: "10",
      author: { id: "30", username: "ada" },
    }, 7);
    expect(connector.lastSequence()).toBe(7);
    gateway.close(4000, "drop");
    gateway.hello(60_000);
    expect(gateway.lastResume()).toMatchObject({ token, session_id: "sess-1", seq: 7 });
    gateway.resumed(8);
    expect(connector.sessionId()).toBe("sess-1");
    expect(JSON.stringify(gateway.sent)).toContain(token);
    const safeStatus = JSON.stringify(connector.status());
    expect(safeStatus).not.toContain(token);
    await connector.disconnect();
  });

  it("dedups messages, ignores the bot's own author, and emits authorized inbound + reactions", async () => {
    const { connector, gateway } = await connectLive();
    const recorder = recordChannelEvents(connector);
    gateway.dispatch("MESSAGE_CREATE", {
      id: "m1",
      content: "ping",
      channel_id: "20",
      guild_id: "10",
      author: { id: "bot-9", bot: true },
    }, 2);
    gateway.dispatch("MESSAGE_CREATE", {
      id: "m2",
      content: "from ada",
      channel_id: "20",
      guild_id: "10",
      thread_id: "99",
      referenced_message: { id: "prior" },
      author: { id: "30", username: "ada" },
      attachments: [{ id: "a1", filename: "note.txt", content_type: "text/plain", size: 4 }],
    }, 3);
    gateway.dispatch("MESSAGE_CREATE", {
      id: "m2",
      content: "duplicate",
      channel_id: "20",
      guild_id: "10",
      author: { id: "30", username: "ada" },
    }, 4);
    const inbound = await recorder.until((event) => event.type === "inbound");
    if (inbound.type !== "inbound") throw new Error("expected inbound");
    expect(inbound.message.text).toBe("from ada");
    expect(inbound.message.replyToId).toBe("prior");
    expect(inbound.message.address.target).toBe("10/20/99");
    expect(inbound.message.attachments).toEqual([{ id: "a1", name: "note.txt", mime: "text/plain", sizeBytes: 4 }]);
    expect(recorder.events.filter((event) => event.type === "inbound")).toHaveLength(1);
    expect(resolveApprovalsForChannelEvent(inbound.message)).toBeNull();
    expect(CHANNEL_EVENTS_INHERIT_STANDING_APPROVALS).toBe(false);

    gateway.dispatch("MESSAGE_REACTION_ADD", {
      user_id: "30",
      message_id: "m2",
      channel_id: "20",
      guild_id: "10",
      emoji: { name: "👍" },
    }, 5);
    const reaction = await recorder.until((event) => event.type === "reaction");
    if (reaction.type !== "reaction") throw new Error("expected reaction");
    expect(reaction.reaction.emoji).toBe("👍");
    recorder.stop();
    await connector.disconnect();
  });

  it("drops unauthorized inbound when the allowlist is empty", async () => {
    const gateway = createFakeDiscordGateway();
    const rest = createFakeDiscordRest();
    const connector = createDiscordChannelConnector({ id: "discord", config: { enabled: true } });
    const connecting = connector.connect({ token: canary(), transport: gateway.transport, rest });
    gateway.hello();
    gateway.ready();
    await connecting;
    const recorder = recordChannelEvents(connector);
    gateway.dispatch("MESSAGE_CREATE", {
      id: "denied",
      content: "nope",
      channel_id: "20",
      author: { id: "30", username: "ada" },
    }, 2);
    expect(recorder.events.filter((event) => event.type === "inbound")).toEqual([]);
    recorder.stop();
    await connector.disconnect();
  });

  it("sends split outbound text, enforces attachment bounds, and books rate-limit buckets", async () => {
    const { connector, rest } = await connectLive();
    const recorder = recordChannelEvents(connector);
    const address = connector.parseAddress("10/20");
    const tooBig = await connector.send({
      connectorId: "discord",
      address,
      text: "hold",
      attachments: [{ id: "big", name: "huge.bin", sizeBytes: 9 * 1024 * 1024 }],
    });
    expect(tooBig.state).toBe("failed");
    expect(tooBig.error).toMatch(/byte limit/);

    const long = `${"x".repeat(2001)}`;
    const sent = await connector.send({ connectorId: "discord", address, text: long, replyToId: "prior" });
    expect(sent.state).toBe("sent");
    expect(rest.sent.filter((row) => row.method === "POST")).toHaveLength(2);
    const first = rest.sent.find((row) => row.method === "POST");
    expect(first?.body).toMatchObject({ message_reference: { message_id: "prior" } });
    await recorder.until((event) => event.type === "receipt" && event.receipt.state === "sent");

    rest.nextStatus = 429;
    rest.nextHeaders = { "retry-after": "1", "x-ratelimit-remaining": "0" };
    const limited = await connector.send({ connectorId: "discord", address, text: "later" });
    expect(limited.state).toBe("rate_limited");
    expect(connector.rateLimit().limited).toBe(true);
    recorder.stop();
    await connector.disconnect();
  });

  it("forgets the token on disconnect and never echoes it in receipts", async () => {
    const { connector, token } = await connectLive();
    await connector.disconnect();
    expect(connector.status()).toMatchObject({ configured: false, status: "disconnected" });
    const receipt = await connector.send({
      connectorId: "discord",
      address: connector.parseAddress("20"),
      text: `bot ${token}`,
    });
    expect(receipt.state).toBe("failed");
    expect(JSON.stringify(receipt)).not.toContain(token);
    expect(JSON.stringify(connector.status())).not.toContain(token);
  });
});
