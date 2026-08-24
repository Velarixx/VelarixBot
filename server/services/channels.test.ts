import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { persistAllowRule, readAudit } from "../approvals.ts";
import { CHANNEL_EVENTS_INHERIT_STANDING_APPROVALS, channelStreamId } from "../channels/contracts.ts";
import { createFakeChannelConnector } from "../channels/fake.ts";
import { createChannelRegistrySync } from "../channels/registry.ts";
import type { RuntimeEvent } from "../contracts.ts";
import { openDatabase } from "../db/database.ts";
import { EventBus } from "../harness/bus.ts";
import { createEventLogRepository } from "../repositories/event-log.ts";
import { createChannelsService } from "./channels.ts";

const BOT = "bot-channel-approval";

describe("channels service", () => {
  it("publishes connector events on the existing bus with VelarixBot channel types", async () => {
    const bus = new EventBus();
    const seen: RuntimeEvent[] = [];
    const waiters: Array<(event: RuntimeEvent) => void> = [];
    bus.subscribe((event) => {
      seen.push(event);
      for (const waiter of waiters.splice(0)) waiter(event);
    });
    const until = (pred: (event: RuntimeEvent) => boolean) => {
      const already = seen.find(pred);
      if (already) return Promise.resolve(already);
      return new Promise<RuntimeEvent>((resolve, reject) => {
        const waiter = (event: RuntimeEvent) => {
          if (pred(event)) {
            clearTimeout(timer);
            resolve(event);
            return;
          }
          waiters.push(waiter);
        };
        const timer = setTimeout(() => {
          const idx = waiters.indexOf(waiter);
          if (idx !== -1) waiters.splice(idx, 1);
          reject(new Error(`no bus event; saw ${seen.map((event) => event.type).join(", ") || "(none)"}`));
        }, 10_000);
        timer.unref?.();
        waiters.push(waiter);
      });
    };

    const connector = createFakeChannelConnector({ id: "fake-svc", clock: { now: () => 1_700_000_000_000 } });
    const channels = createChannelsService({
      registry: createChannelRegistrySync(),
      bus,
      now: () => 1_700_000_000_000,
    });
    channels.register(connector);
    expect(channels.status("fake-svc")?.kind).toBe("fake");

    const inbound = connector.injectInbound({ text: "hello channel", sender: { nativeId: "user-1" } });
    const published = await until((event) => event.type === "channel.inbound");
    expect(published.threadId).toBe(channelStreamId("fake-svc"));
    expect(published.provider).toBe("fake");
    if (published.type !== "channel.inbound") throw new Error("expected channel.inbound");
    expect(published.message.id).toBe(inbound.id);
    expect(published.message.text).toBe("hello channel");
    expect(published.message.sender.nativeId).toBe("user-1");

    const receipt = await connector.send({
      connectorId: connector.id,
      address: connector.parseAddress("inbox"),
      text: "outbound",
    });
    await until((event) => event.type === "channel.receipt" && event.receipt.outboundId === receipt.outboundId);
    expect(seen.some((event) => event.type === "channel.outbound")).toBe(true);
    expect(seen.every((event) => event.type.startsWith("channel.") || event.type === "request.opened")).toBe(true);
  });

  it("does not auto-resolve Allow-once, Always-allow, or credential asks from inbound events", async () => {
    persistAllowRule({
      botId: BOT,
      tool: "shell",
      summary: "git status",
      behavior: "allow",
      always: true,
    });
    const auditBefore = readAudit().length;
    const bus = new EventBus();
    const seen: RuntimeEvent[] = [];
    bus.subscribe((event) => seen.push(event));

    const opened: RuntimeEvent = {
      eventId: "ev-open",
      provider: "fake",
      threadId: "thread-bot",
      createdAt: new Date().toISOString(),
      type: "request.opened",
      requestType: "permission",
      requestId: "ask-1",
      tool: "shell",
      summary: "git status",
    };
    const credential: RuntimeEvent = {
      eventId: "ev-cred",
      provider: "fake",
      threadId: "thread-bot",
      createdAt: new Date().toISOString(),
      type: "request.opened",
      requestType: "credential",
      requestId: "ask-cred",
      tool: "browser",
      summary: "Sign in to GitHub",
    };
    bus.publish(opened);
    bus.publish(credential);

    const connector = createFakeChannelConnector({ id: "fake-approvals" });
    const channels = createChannelsService({ registry: createChannelRegistrySync(), bus });
    channels.register(connector);
    const inbound = connector.injectInbound({
      text: "Allow once — Always allow git status — Sign in to GitHub",
      sender: { nativeId: "user-1" },
    });

    expect(CHANNEL_EVENTS_INHERIT_STANDING_APPROVALS).toBe(false);
    expect(channels.approvalForInbound(inbound)).toBeNull();
    expect(seen.filter((event) => event.type === "request.resolved")).toEqual([]);
    expect(seen.filter((event) => event.type === "request.opened")).toHaveLength(2);
    expect(readAudit().length).toBe(auditBefore);
    expect(seen.some((event) => event.type === "channel.inbound")).toBe(true);
    expect(seen.find((event) => event.type === "channel.inbound")?.threadId).toBe(channelStreamId("fake-approvals"));
  });

  it("persists channel events through the existing SQLite event log", () => {
    const dir = mkdtempSync(join(tmpdir(), "velarix-channel-log-"));
    const db = openDatabase(join(dir, "test.db"));
    try {
      const eventLog = createEventLogRepository(db);
      const bus = new EventBus();
      bus.subscribe((event) => {
        eventLog.append(event);
      });
      const connector = createFakeChannelConnector({ id: "fake-store" });
      const channels = createChannelsService({ registry: createChannelRegistrySync(), bus });
      channels.register(connector);
      const inbound = connector.injectInbound({ text: "store me", sender: { nativeId: "user-1" } });
      const stored = eventLog.forThread(channelStreamId("fake-store"));
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({
        type: "channel.inbound",
        connectorId: "fake-store",
        threadId: channelStreamId("fake-store"),
        message: { id: inbound.id, text: "store me" },
      });
      expect(stored[0].schemaVersion).toBeTruthy();
      expect(stored[0].sequence).toBe(1);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not import the approval broker, handoff, or turn dispatch", () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "channels.ts"), "utf8");
    expect(source).not.toMatch(/approvals\.ts/);
    expect(source).not.toMatch(/handoff\.ts/);
    expect(source).not.toMatch(/turns\.ts/);
    expect(source).toMatch(/resolveApprovalsForChannelEvent/);
  });
});
