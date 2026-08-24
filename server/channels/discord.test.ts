import { describe, expect, it } from "vitest";

import {
  DiscordChannelFactory,
  createDiscordStubConnector,
  decodeDiscordChannelConfig,
  formatDiscordAddress,
  parseDiscordAddress,
} from "./discord.ts";

describe("discord channel stub", () => {
  it("parses and formats discord: addresses without touching the network", () => {
    const address = parseDiscordAddress("discord:1234567890", "discord");
    expect(address).toEqual({
      connectorId: "discord",
      kind: "discord",
      target: "1234567890",
      display: "discord:1234567890",
    });
    expect(formatDiscordAddress(address)).toBe("discord:1234567890");
    expect(() => parseDiscordAddress("", "discord")).toThrow(/address/);
    expect(() => parseDiscordAddress("fake:inbox", "discord")).toThrow(/scheme/);
  });

  it("rejects live Gateway config and stays unavailable", async () => {
    expect(() => decodeDiscordChannelConfig({ token: "anything" })).toThrow(/live Gateway/);
    expect(() => decodeDiscordChannelConfig("x")).toThrow(/must be an object/);
    const connector = createDiscordStubConnector("discord");
    expect(connector.status()).toMatchObject({
      configured: false,
      enabled: false,
      status: "unavailable",
    });
    expect(connector.status().statusMessage).toMatch(/not implemented/);
    await expect(
      connector.send({
        connectorId: "discord",
        address: parseDiscordAddress("general", "discord"),
        text: "nope",
      }),
    ).rejects.toThrow(/does not support/);
    const created = await DiscordChannelFactory.create({ id: "discord-2", config: {} });
    expect(created.id).toBe("discord-2");
    expect(created.capabilities).toEqual({ send: false, receive: false, reactions: false, receipts: false });
  });
});
