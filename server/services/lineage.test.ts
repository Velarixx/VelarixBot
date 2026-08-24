// P7 letter pins: one requestId from inbound → turn → tools → outbound;
// tool events carry it; errors are redacted and bounded; usage increments;
// public views expose counts/ids only; no Sentry / secrets.
import { readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { persistAllowRule, readAudit } from "../approvals.ts";
import { channelStreamId } from "../channels/contracts.ts";
import { createFakeChannelConnector } from "../channels/fake.ts";
import { createChannelRegistrySync } from "../channels/registry.ts";
import type { RuntimeEvent } from "../contracts.ts";
import { DATA_DIR } from "../config.ts";
import { defaultDbPath, openDatabase } from "../db/database.ts";
import type { SqliteDatabase } from "../db/sqlite-native.ts";
import { EventBus } from "../harness/bus.ts";
import { ProviderRegistry } from "../harness/registry.ts";
import { createComputerRegistry } from "../computer/registry.ts";
import { createProactive } from "../proactive.ts";
import { createRepositories, type Repositories } from "../repositories/index.ts";
import { LINEAGE_ERROR_MAX } from "../repositories/lineage.ts";
import { createBotsService, type BotsService } from "./bots.ts";
import { createChannelsService } from "./channels.ts";
import { createGroupsService } from "./groups.ts";
import { createLineageService, publicLineageFieldNames, publicStepFieldNames, type LineageService } from "./lineage.ts";
import { createRoutinesService, type RoutinesService } from "./routines.ts";
import { createTeachService } from "./teach.ts";
import { createTurnsService, type TurnsService } from "./turns.ts";
import { createUsageService, publicUsageFieldNames, type UsageService } from "./usage.ts";
import { makeFakeDriver, type FakeDriverHandle } from "../testing/fake-driver.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

function recordEvents(): {
  events: RuntimeEvent[];
  frames: Array<Record<string, unknown>>;
  broadcast: (payload: unknown) => void;
  untilEvent: (pred: (event: RuntimeEvent) => boolean) => Promise<RuntimeEvent>;
  untilFrame: (pred: (frame: Record<string, unknown>) => boolean) => Promise<Record<string, unknown>>;
} {
  const events: RuntimeEvent[] = [];
  const frames: Array<Record<string, unknown>> = [];
  const eventWaiters: Array<(event: RuntimeEvent) => void> = [];
  const frameWaiters: Array<() => void> = [];
  return {
    events,
    frames,
    broadcast(payload) {
      frames.push(payload as Record<string, unknown>);
      for (const w of frameWaiters.splice(0)) w();
    },
    untilEvent(pred) {
      const already = events.find(pred);
      if (already) return Promise.resolve(already);
      return new Promise((resolve, reject) => {
        const waiter = (event: RuntimeEvent) => {
          if (!pred(event)) {
            eventWaiters.push(waiter);
            return;
          }
          clearTimeout(timer);
          resolve(event);
        };
        const timer = setTimeout(() => {
          const idx = eventWaiters.indexOf(waiter);
          if (idx !== -1) eventWaiters.splice(idx, 1);
          reject(new Error(`no matching runtime event; saw ${events.map((e) => e.type).join(", ") || "(none)"}`));
        }, 5_000);
        timer.unref?.();
        eventWaiters.push(waiter);
      });
    },
    untilFrame(pred) {
      const already = frames.find(pred);
      if (already) return Promise.resolve(already);
      return new Promise((resolve, reject) => {
        const tryNow = () => {
          const hit = frames.find(pred);
          if (!hit) return;
          const idx = frameWaiters.indexOf(tryNow);
          if (idx !== -1) frameWaiters.splice(idx, 1);
          clearTimeout(timer);
          resolve(hit);
        };
        const timer = setTimeout(() => {
          const idx = frameWaiters.indexOf(tryNow);
          if (idx !== -1) frameWaiters.splice(idx, 1);
          reject(new Error(`no matching SSE frame; saw ${frames.map((f) => String(f.kind)).join(", ") || "(none)"}`));
        }, 5_000);
        timer.unref?.();
        frameWaiters.push(tryNow);
      });
    },
  };
}

describe("request lineage + local usage (P7)", () => {
  let db: SqliteDatabase;
  let repos: Repositories;
  let lineage: LineageService;
  let usage: UsageService;

  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    db = openDatabase(defaultDbPath());
    repos = createRepositories(db);
    lineage = createLineageService({ store: repos.lineage, now: () => 1_700_000_000_000 });
    usage = createUsageService({ store: repos.usage, now: () => 1_700_000_000_000 });
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  });

  it("begin is idempotent on sourceRef so inbound and startTurn share one id", () => {
    const first = lineage.begin({ source: "channel", sourceRef: "msg-1" });
    const second = lineage.begin({ source: "channel", sourceRef: "msg-1", botId: "bot-a" });
    expect(first.created).toBe(true);
    expect(second).toEqual({ requestId: first.requestId, created: false });
    expect(lineage.get(first.requestId)?.botId).toBe("bot-a");
  });

  it("redacts and bounds errors; public view has no secret fields", () => {
    const { requestId } = lineage.begin({ source: "user" });
    lineage.noteError(requestId, `spawn failed token=sk-ant-${"aB9".repeat(12)} and Bearer super-secret-value`);
    const view = lineage.publicView(requestId)!;
    expect(view.error).toBeTruthy();
    expect(view.error!.length).toBeLessThanOrEqual(LINEAGE_ERROR_MAX);
    expect(view.error).toContain("[redacted]");
    expect(view.error).not.toContain("sk-ant-");
    expect(view.error).not.toContain("super-secret-value");
    expect(Object.keys(view).sort()).toEqual([...publicLineageFieldNames()].filter((k) => k in view).sort());
    expect(Object.keys(view).some((k) => /token|secret|password|dsn|key/i.test(k))).toBe(false);
    for (const step of view.steps) {
      expect(Object.keys(step).every((k) => (publicStepFieldNames() as readonly string[]).includes(k))).toBe(true);
    }
  });

  it("does not consult the approval broker and never mentions Sentry", () => {
    persistAllowRule({
      botId: "bot-lineage",
      tool: "Bash",
      summary: "echo hi",
      behavior: "allow",
      always: true,
      scope: "bot",
      requestType: "permission",
    });
    const before = readAudit().length;
    lineage.begin({ source: "channel", sourceRef: "unattended-event" });
    expect(readAudit()).toHaveLength(before);
    const files = [
      join(HERE, "lineage.ts"),
      join(HERE, "usage.ts"),
      join(HERE, "..", "routes", "diagnostics.ts"),
    ];
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      expect(src, file).not.toMatch(/@sentry|SENTRY_DSN|sentry\.io/i);
    }
  });

  it("usage totals are counts only", () => {
    usage.record("claudeAgent", { requests: 1, inputTokens: 10, outputTokens: 4 });
    const totals = usage.totals();
    expect(totals).toEqual([{ provider: "claudeAgent", requests: 1, inputTokens: 10, outputTokens: 4 }]);
    expect(Object.keys(totals[0]).sort()).toEqual([...publicUsageFieldNames()].sort());
    expect(JSON.stringify(totals)).not.toMatch(/secret|password|dsn|invoice/i);
  });
});

describe("lineage through turn + channel (P7)", () => {
  let db: SqliteDatabase;
  let repos: Repositories;
  let bots: BotsService;
  let turns: TurnsService;
  let lineage: LineageService;
  let usage: UsageService;
  let fake: FakeDriverHandle;
  let recorder: ReturnType<typeof recordEvents>;

  beforeEach(async () => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    db = openDatabase(defaultDbPath());
    repos = createRepositories(db);
    lineage = createLineageService({ store: repos.lineage, now: () => Date.now() });
    usage = createUsageService({ store: repos.usage, now: () => Date.now() });
    fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ fake: { driver: "fake", displayName: "Fake", config: {} } });
    const bus = new EventBus();
    bus.attach(registry.instances());
    recorder = recordEvents();
    bus.subscribe((event) => {
      recorder.events.push(event);
    });
    bots = createBotsService({
      repos,
      defaultSelection: () => ({ instanceId: "fake", model: "fake-1" }),
    });
    const groups = createGroupsService({ repos });
    const computers = await createComputerRegistry({ cfg: { computer: { providers: {} } } });
    const teach = createTeachService({
      bus,
      registry,
      bot: (id) => bots.bot(id),
      patchBot: (id, patch) => bots.patchBot(id, patch),
    });
    const proactive = createProactive({ now: () => Date.now(), onNudge: () => {}, onTrigger: () => {} });
    let routinesRef: RoutinesService | null = null;
    turns = createTurnsService({
      cfg: { instances: { fake: { driver: "fake", config: {} } } },
      registry,
      computers,
      bus,
      repos,
      bots,
      groups,
      routines: () => routinesRef!,
      teach,
      proactive,
      broadcast: recorder.broadcast,
      port: 0,
      commsToken: "test-lineage",
      lineage,
      usage,
    });
    routinesRef = createRoutinesService({
      repos,
      now: () => Date.now(),
      broadcast: recorder.broadcast,
      bot: (id) => {
        const b = bots.bot(id);
        return b ? { id: b.id, threadId: b.threadId, busy: b.busy, hidden: b.hidden === true } : null;
      },
      startTurn: (botId, text, opts) => turns.startTurn(botId, text, opts),
      getSkill: () => null,
      skillPrompt: (_s, p) => p,
    });
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  });

  it("stamps the same requestId on turn, tool, SSE, and usage", async () => {
    const bot = bots.createBot();
    bots.patchBot(bot.id, { modelSelection: { instanceId: "fake", model: "fake-1" } });
    const live = fake.created.get("fake");
    if (!live) throw new Error("fake instance missing");
    const { requestId } = lineage.begin({ source: "user", botId: bot.id });
    await turns.startTurn(bot.id, "hello lineage", { requestId });
    live.emit({
      eventId: "ev-turn-start",
      provider: "fake",
      threadId: bot.threadId,
      createdAt: new Date().toISOString(),
      type: "turn.started",
      turnId: "turn-lineage",
    });
    live.emit({
      eventId: "ev-tool",
      provider: "fake",
      threadId: bot.threadId,
      createdAt: new Date().toISOString(),
      type: "item.started",
      itemType: "tool",
      itemId: "tool-1",
      title: "web_search",
      turnId: "turn-lineage",
    });
    live.emit({
      eventId: "ev-usage",
      provider: "fake",
      threadId: bot.threadId,
      createdAt: new Date().toISOString(),
      type: "thread.token-usage.updated",
      turnId: "turn-lineage",
      input: 11,
      output: 4,
    });
    live.emit({
      eventId: "ev-turn-done",
      provider: "fake",
      threadId: bot.threadId,
      createdAt: new Date().toISOString(),
      type: "turn.completed",
      turnId: "turn-lineage",
      ok: true,
    });
    const toolFrame = await recorder.untilFrame(
      (frame) =>
        frame.kind === "runtime" &&
        (frame.event as { type?: string; itemType?: string })?.type === "item.started" &&
        (frame.event as { itemType?: string })?.itemType === "tool",
    );
    expect(toolFrame.requestId).toBe(requestId);
    expect((toolFrame.event as { lineageId?: string }).lineageId).toBe(requestId);
    const view = lineage.publicView(requestId)!;
    expect(view.turnId).toBe("turn-lineage");
    expect(view.steps.some((s) => s.kind === "tool" && s.ref === "tool-1")).toBe(true);
    expect(usage.totals()).toEqual([{ provider: "fake", requests: 1, inputTokens: 11, outputTokens: 4 }]);
  });

  it("correlates channel inbound → turn → outbound on one id", async () => {
    const bot = bots.createBot();
    bots.patchBot(bot.id, { modelSelection: { instanceId: "fake", model: "fake-1" } });
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
          reject(new Error(`no bus event; saw ${seen.map((e) => e.type).join(", ") || "(none)"}`));
        }, 5_000);
        timer.unref?.();
        waiters.push(waiter);
      });
    };
    const connector = createFakeChannelConnector({ id: "fake-lineage", clock: { now: () => Date.now() } });
    const channels = createChannelsService({
      registry: createChannelRegistrySync(),
      bus,
      lineage,
    });
    channels.register(connector);
    const inbound = connector.injectInbound({ text: "from channel", id: "in-lineage-1", sender: { nativeId: "u-1" } });
    const inboundEvent = await until((event) => event.type === "channel.inbound");
    expect(inboundEvent.requestId).toBeTruthy();
    expect(inboundEvent.lineageId).toBe(inboundEvent.requestId);
    expect(inboundEvent.threadId).toBe(channelStreamId("fake-lineage"));
    const requestId = inboundEvent.requestId!;
    expect(lineage.begin({ source: "channel", sourceRef: inbound.id }).requestId).toBe(requestId);
    await turns.startTurn(bot.id, inbound.text, { requestId, unattended: true });
    const receipt = await connector.send({
      connectorId: connector.id,
      address: connector.parseAddress("inbox"),
      text: "reply",
      requestId,
    });
    const outboundEvent = await until((event) => event.type === "channel.outbound" && event.outboundId === receipt.outboundId);
    expect(outboundEvent.requestId).toBe(requestId);
    expect(outboundEvent.lineageId).toBe(requestId);
    const view = lineage.publicView(requestId)!;
    expect(view.source).toBe("channel");
    expect(view.sourceRef).toBe("in-lineage-1");
    expect(view.outboundId).toBe(receipt.outboundId);
    expect(view.steps.map((s) => s.kind)).toContain("inbound");
    expect(view.steps.map((s) => s.kind)).toContain("outbound");
  });
});
