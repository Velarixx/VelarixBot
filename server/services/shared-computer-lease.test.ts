// Shared-computer lease wiring at the turn-dispatch site (FAIL-if 6):
// two bots bound to the SAME machine serialize FIFO, the loser of a
// timeout fails LOUD with "computer busy — in use by <botName>", an
// interrupted queued turn releases its wait, and completion hands the
// machine to the next bot. Fake driver + a fake shared computer provider —
// no vendors, isolated HOME (vitest setup), no sleeps beyond the lease's
// own timeout window under test.
import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "../config.ts";
import type { RuntimeEvent } from "../contracts.ts";
import { defaultDbPath, openDatabase } from "../db/database.ts";
import type { SqliteDatabase } from "../db/sqlite-native.ts";
import { EventBus } from "../harness/bus.ts";
import { ProviderRegistry } from "../harness/registry.ts";
import { createLeaseBroker, type LeaseBroker } from "../computer/leases.ts";
import { createComputerRegistry } from "../computer/registry.ts";
import type { ComputerProviderFactory } from "../computer/provider.ts";
import { createProactive } from "../proactive.ts";
import { createRepositories, type Repositories } from "../repositories/index.ts";
import { createBotsService, type BotsService } from "./bots.ts";
import { createRoutinesService, type RoutinesService } from "./routines.ts";
import { createTeachService } from "./teach.ts";
import { createTurnsService, type TurnsService } from "./turns.ts";
import { makeFakeDriver } from "../testing/fake-driver.ts";

/** Every bot resolves to the ONE machine `m-shared` — the provider-internal
 * consequence of shared mode, seen through the untouched SPI. */
const SharedMachineFactory: ComputerProviderFactory<Record<string, never>> = {
  kind: "sharedfake",
  metadata: { displayName: "Shared fake" },
  decodeConfig: () => ({}),
  async create({ id }) {
    return {
      id,
      kind: "sharedfake",
      displayName: "Shared fake",
      capabilities: { exec: false, screenshot: false, files: false, desktopUrl: false, suspend: false, destroy: false, mcp: false },
      turnPrompt: "",
      status: async () => ({ configured: true, machine: { id: "m-shared", state: "running" } }),
      provision: async () => ({ machineId: "m-shared", reused: true, state: "running" }),
      // eslint-disable-next-line require-yield
      async *execute() {
        throw new Error("unused");
      },
      connectScreen: async () => ({ kind: "url" as const, url: "fake://desktop" }),
      suspend: async () => {},
      destroy: async () => {},
      screenshot: async () => ({ png: "", format: "png" as const }),
      readFile: async () => ({ content: "", path: "/" }),
      mcpIntegration: async () => null,
    };
  },
};

describe("shared-computer lease at turn dispatch", () => {
  let db: SqliteDatabase | undefined;
  let repos: Repositories;
  let bots: BotsService;
  let turns: TurnsService;
  let turnsReady = false;
  let bus: EventBus;
  let registry: ProviderRegistry | undefined;
  let leases: LeaseBroker | undefined;
  let sendTurns: string[]; // threadIds, in dispatch order
  let broadcasts: Array<Record<string, unknown>>;
  let broadcastWaiters: Array<{
    pred: (f: any) => boolean;
    resolve: (f: any) => void;
    timer: ReturnType<typeof setTimeout>;
  }>;

  const selection = () => ({ instanceId: "fake", model: "fake-1" });

  const untilBroadcast = (pred: (f: any) => boolean, timeoutMs = 5_000): Promise<any> => {
    const seen = broadcasts.find(pred);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      let waiter: (typeof broadcastWaiters)[number];
      waiter = {
        pred,
        resolve,
        timer: setTimeout(() => {
          const index = broadcastWaiters.indexOf(waiter);
          if (index !== -1) broadcastWaiters.splice(index, 1);
          reject(new Error(`no matching broadcast; saw ${broadcasts.map((b) => b.kind).join(",")}`));
        }, timeoutMs),
      };
      const { timer } = waiter;
      timer.unref?.();
      broadcastWaiters.push(waiter);
    });
  };

  const completed = (threadId: string): RuntimeEvent => ({
    eventId: `ev-done-${threadId}-${Math.random()}`,
    provider: "fake",
    providerInstanceId: "fake",
    threadId,
    createdAt: new Date().toISOString(),
    type: "turn.completed",
    ok: true,
  });

  const flush = async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  };

  async function teardown() {
    for (const waiter of broadcastWaiters ?? []) clearTimeout(waiter.timer);
    broadcastWaiters = [];

    if (turnsReady) {
      turnsReady = false;
      for (const bot of bots.bots()) await turns.interrupt(bot.id);
      await flush();
      expect(leases?.holder("sharedfake:m-shared")).toBeNull();
      expect(leases?.waiting("sharedfake:m-shared")).toEqual([]);
    }
    leases = undefined;
    bus?.detachAll();
    await registry?.disposeAll();
    registry = undefined;
    db?.close();
    db = undefined;
  }

  async function setup(leaseWaitMs?: number) {
    await teardown();
    rmSync(DATA_DIR, { recursive: true, force: true });
    db = openDatabase(defaultDbPath());
    repos = createRepositories(db);
    sendTurns = [];
    broadcasts = [];
    broadcastWaiters = [];

    const fake = makeFakeDriver();
    registry = new ProviderRegistry([fake.driver]);
    await registry.load({ fake: { driver: "fake", displayName: "Fake" } });
    const live = fake.created.get("fake")!;
    // the fake driver stands in for any cloud-computer-capable adapter
    // (claudeAgent/codex mounting the MCP tools, or boxAgent running ON the
    // machine — dispatch treats both identically)
    (live.instance.adapter as { capabilities: typeof live.instance.adapter.capabilities }).capabilities = {
      ...live.instance.adapter.capabilities,
      cloudComputer: true,
    };
    live.instance.adapter.sendTurn = async (turn) => {
      sendTurns.push(turn.threadId);
      return { turnId: `t-${sendTurns.length}` };
    };

    bus = new EventBus();
    bus.attach(registry.instances());
    bots = createBotsService({
      repos,
      defaultSelection: selection,
      computerBindings: () => ["sharedbox"],
    });
    const computers = await createComputerRegistry({
      cfg: { computer: { providers: { sharedbox: { kind: "sharedfake" } } } },
      factories: [SharedMachineFactory],
    });
    const teach = createTeachService({
      bus,
      registry,
      bot: (id) => bots.bot(id),
      patchBot: (id, patch) => bots.patchBot(id, patch),
    });
    const proactive = createProactive({ now: () => Date.now(), onNudge: () => {}, onTrigger: () => {} });
    leases = createLeaseBroker();
    let routinesRef: RoutinesService | null = null;
    turns = createTurnsService({
      cfg: { ...(leaseWaitMs !== undefined ? { box: { leaseWaitMs } } : {}) },
      registry,
      computers,
      bus,
      repos,
      bots,
      routines: () => routinesRef!,
      teach,
      proactive,
      leases,
      broadcast: (frame) => {
        broadcasts.push(frame as Record<string, unknown>);
        for (let i = broadcastWaiters.length - 1; i >= 0; i--) {
          if (broadcastWaiters[i].pred(frame)) {
            const [w] = broadcastWaiters.splice(i, 1);
            clearTimeout(w.timer);
            w.resolve(frame);
          }
        }
      },
      port: 0,
      commsToken: "test-lease",
    });
    turnsReady = true;
    routinesRef = createRoutinesService({
      repos,
      now: () => Date.now(),
      broadcast: () => {},
      bot: (id) => {
        const b = bots.bot(id);
        return b ? { id: b.id, threadId: b.threadId, busy: b.busy, hidden: b.hidden === true } : null;
      },
      startTurn: (botId, text, opts) => turns.startTurn(botId, text, opts),
      getSkill: () => null,
      skillPrompt: (_s, p) => p,
      pollListener: async () => ({ status: "no-match" as const, cursor: "0" }),
    });
  }

  function sharedBot(name: string) {
    const bot = bots.createBot();
    bots.patchBot(bot.id, { name, computer: "sharedbox" });
    return bots.bot(bot.id)!;
  }

  afterEach(teardown);

  beforeEach(async () => {
    await setup();
  });

  it("serializes two bots FIFO on the one machine and hands over on turn.completed", async () => {
    const ada = sharedBot("Ada");
    const bea = sharedBot("Bea");

    await turns.startTurn(ada.id, "go");
    await flush();
    expect(sendTurns).toEqual([ada.threadId]);

    await turns.startTurn(bea.id, "go too");
    await flush();
    // Bea is queued behind Ada — her turn must NOT reach the driver yet
    expect(sendTurns).toEqual([ada.threadId]);

    bus.publish(completed(ada.threadId));
    await flush();
    expect(sendTurns).toEqual([ada.threadId, bea.threadId]);

    bus.publish(completed(bea.threadId));
    await flush();
    expect(bots.bot(bea.id)!.busy).toBe(false);
  });

  it("times out LOUD: 'computer busy — in use by <botName>', no silent proceed", async () => {
    await setup(10); // cfg.box.leaseWaitMs override (D3)
    const ada = sharedBot("Ada");
    const bea = sharedBot("Bea");

    await turns.startTurn(ada.id, "hold the box");
    await flush();
    await turns.startTurn(bea.id, "wait for it");

    const failure = await untilBroadcast(
      (f) => f.kind === "message" && f.threadId === bea.threadId && /computer busy — in use by Ada/.test(f.message?.tool?.name ?? ""),
    );
    expect(failure.message.tool.ok).toBe(false);
    expect(bots.bot(bea.id)!.state).toBe("BLOCKED");
    expect(bots.bot(bea.id)!.stateDetail).toContain("computer busy — in use by Ada");
    // Bea's turn never reached the driver — no proceed-without-tools
    expect(sendTurns).toEqual([ada.threadId]);

    // Ada still holds and completes normally; the machine frees up
    bus.publish(completed(ada.threadId));
    await flush();
    await turns.startTurn(bea.id, "retry");
    await flush();
    expect(sendTurns).toEqual([ada.threadId, bea.threadId]);
  });

  it("releases on abort: interrupting a QUEUED bot drops its wait; the next bot gets the machine", async () => {
    const ada = sharedBot("Ada");
    const bea = sharedBot("Bea");
    const cyd = sharedBot("Cyd");

    await turns.startTurn(ada.id, "hold");
    await flush();
    await turns.startTurn(bea.id, "queue up");
    await flush();
    expect(sendTurns).toEqual([ada.threadId]);

    await turns.interrupt(bea.id); // abort while queued
    await flush();
    expect(sendTurns).toEqual([ada.threadId]); // Bea never dispatched

    await turns.startTurn(cyd.id, "queue next");
    await flush();
    bus.publish(completed(ada.threadId));
    await flush();
    // Bea's aborted wait did not consume the handover — Cyd runs
    expect(sendTurns).toEqual([ada.threadId, cyd.threadId]);
  });

  it("interrupting the HOLDER releases the machine for the queue", async () => {
    const ada = sharedBot("Ada");
    const bea = sharedBot("Bea");

    await turns.startTurn(ada.id, "hold");
    await flush();
    await turns.startTurn(bea.id, "queue");
    await flush();
    expect(sendTurns).toEqual([ada.threadId]);

    await turns.interrupt(ada.id);
    await flush();
    expect(sendTurns).toEqual([ada.threadId, bea.threadId]);
  });
});
