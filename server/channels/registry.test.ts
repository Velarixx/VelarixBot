import { describe, expect, it } from "vitest";

import { DiscordChannelFactory } from "./discord.ts";
import { FakeChannelFactory, decodeFakeChannelConfig } from "./fake.ts";
import { createChannelRegistry } from "./registry.ts";

describe("channel registry", () => {
  it("registers a connector and looks it up by id", async () => {
    const fake = await FakeChannelFactory.create({ id: "fake-1", config: {} });
    const registry = await createChannelRegistry();
    expect(registry.get("fake-1")).toBeNull();
    registry.register(fake);
    expect(registry.get("fake-1")).toBe(fake);
    expect(registry.list().map((connector) => connector.id)).toEqual(["fake-1"]);
    expect(registry.statuses()[0]).toMatchObject({ id: "fake-1", kind: "fake", configured: true, status: "connected" });
  });

  it("loads a fake entry from the in-memory map and a disconnected discord connector", async () => {
    const registry = await createChannelRegistry({
      entries: {
        inbox: { kind: "fake" },
        discord: { kind: "discord" },
      },
    });
    expect(registry.get("inbox")?.kind).toBe("fake");
    expect(registry.get("discord")?.status()).toMatchObject({
      kind: "discord",
      configured: false,
      status: "disconnected",
    });
    expect(registry.get("discord")?.capabilities).toEqual({
      send: true,
      receive: true,
      reactions: true,
      receipts: true,
    });
  });

  it("downgrades an unknown kind to an unavailable shadow", async () => {
    const registry = await createChannelRegistry({
      entries: { weird: { kind: "irc" } },
    });
    const shadow = registry.get("weird");
    expect(shadow).not.toBeNull();
    expect(shadow!.status().status).toBe("unavailable");
    expect(shadow!.status().statusMessage).toMatch(/unknown channel connector kind "irc"/);
    await expect(shadow!.send({
      connectorId: "weird",
      address: { connectorId: "weird", kind: "irc", target: "x" },
      text: "no",
    })).rejects.toThrow(/unknown channel connector kind/);
  });

  it("downgrades a decodeConfig throw to a shadow", async () => {
    const registry = await createChannelRegistry({
      entries: { bad: { kind: "fake", config: { maxAttempts: 0 } } },
    });
    expect(registry.get("bad")?.status().statusMessage).toMatch(/maxAttempts/);
  });

  it("downgrades a create rejection to a shadow and never sync-throws", async () => {
    const factory = {
      kind: "boom",
      metadata: { displayName: "Boom" },
      decodeConfig: () => ({}),
      create: () => Promise.reject(new Error("create failed")),
    };
    const registry = await createChannelRegistry({
      factories: [factory],
      entries: { x: { kind: "boom" } },
    });
    expect(registry.get("x")?.status().statusMessage).toBe("create failed");
  });
});

describe("channel factory decode/create contract", () => {
  it("fake decodeConfig throws on invalid config", () => {
    expect(() => decodeFakeChannelConfig("nope")).toThrow(/must be an object/);
    expect(() => FakeChannelFactory.decodeConfig({ identities: "x" })).toThrow(/identities/);
  });

  it("discord decodeConfig throws on a token and create rejects only as a promise", async () => {
    expect(() => DiscordChannelFactory.decodeConfig({ token: "live-token" })).toThrow(/SecretStore/);
    await expect(DiscordChannelFactory.create({ id: "discord", config: {} })).resolves.toMatchObject({
      kind: "discord",
    });
  });
});
