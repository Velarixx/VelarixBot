// #150 P0: completed worker + missing room, then exactly-once delivery.
// Fake driver only. Isolated HOME. No sleeps. Delivery never starts a worker.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";

import { configureAgentTasks } from "./agent-tasks.ts";
import { bindCommsStore } from "./comms-visibility.ts";
import { DATA_DIR } from "./config.ts";
import type { RuntimeEvent } from "./contracts.ts";
import { defaultDbPath, openDatabase } from "./db/database.ts";
import type { SqliteDatabase } from "./db/sqlite-native.ts";
import { queueDelegation, _resetPending } from "./delegations.ts";
import { EventBus } from "./harness/bus.ts";
import { ProviderRegistry } from "./harness/registry.ts";
import { createComputerRegistry } from "./computer/registry.ts";
import { createProactive } from "./proactive.ts";
import { createRepositories, type Repositories } from "./repositories/index.ts";
import { createBotsService, type BotsService } from "./services/bots.ts";
import { createGroupsService } from "./services/groups.ts";
import { createRoutinesService, type RoutinesService } from "./services/routines.ts";
import { createTeachService } from "./services/teach.ts";
import { createTurnsService, type TurnsService } from "./services/turns.ts";
import { makeFakeDriver } from "./testing/fake-driver.ts";

const selection = () => ({ instanceId: "fake", model: "fake-1" });

describe("durable delegated results through turns", () => {
  let db: SqliteDatabase;
  let repos: Repositories;
  let bots: BotsService;
  let turns: TurnsService;
  let bus: EventBus;
  let sendTurns: Array<{ threadId: string; text: string }>;

  beforeEach(async () => {
    _resetPending();
    rmSync(DATA_DIR, { recursive: true, force: true });
    db = openDatabase(defaultDbPath());
    repos = createRepositories(db);
    configureAgentTasks(repos.agentTasks);
    sendTurns = [];

    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ fake: { driver: "fake", displayName: "Fake" } });
    const live = fake.created.get("fake")!;
    (live.instance.adapter as { capabilities: typeof live.instance.adapter.capabilities }).capabilities = {
      sessionModelSwitch: "unsupported",
      agentsMcp: true,
    };
    live.instance.adapter.sendTurn = async (turn) => {
      sendTurns.push({ threadId: turn.threadId, text: turn.text });
      return { turnId: `fake-turn-${sendTurns.length}` };
    };

    bus = new EventBus();
    bus.attach(registry.instances());
    bots = createBotsService({ repos, defaultSelection: selection });
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
      cfg: { instances: { fake: { driver: "fake", config: { fullAuto: true } } } },
      registry,
      computers,
      bus,
      repos,
      bots,
      groups,
      routines: () => routinesRef!,
      teach,
      proactive,
      broadcast: () => {},
      port: 0,
      commsToken: "test-delegate",
    });
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
    });
  });

  afterEach(() => {
    _resetPending();
    configureAgentTasks(null);
    try {
      db.close();
    } catch {
      /* already closed */
    }
  });

  async function flush() {
    await Promise.resolve();
    await Promise.resolve();
  }

  function completed(threadId: string, ok = true): RuntimeEvent {
    return {
      eventId: `ev-done-${threadId}-${Date.now()}`,
      provider: "fake",
      providerInstanceId: "fake",
      threadId,
      createdAt: new Date().toISOString(),
      type: "turn.completed",
      ok,
    };
  }

  it("keeps a sealed result when the worker finishes and retries delivery without starting the worker again", async () => {
    const source = bots.createBot();
    const peer = bots.createBot();
    bots.patchBot(source.id, { name: "Chief" });
    bots.patchBot(peer.id, { name: "Helper" });
    const chief = bots.bot(source.id)!;
    const helper = bots.bot(peer.id)!;

    await turns.startTurn(chief.id, "coordinate");
    await flush();
    const groups = createGroupsService({ repos });
    const commsBus = { store: bindCommsStore(bots, groups), broadcast: () => {} };
    expect(queueDelegation(commsBus, chief, { toBotId: helper.id, message: "research this", depth: 0 })).toBe("ok");
    bus.publish(completed(chief.threadId));
    await flush();
    const workerStarts = sendTurns.filter((s) => s.threadId === helper.threadId).length;
    expect(workerStarts).toBe(1);

    bus.publish({
      eventId: `ev-text-${helper.threadId}`,
      provider: "fake",
      providerInstanceId: "fake",
      threadId: helper.threadId,
      createdAt: new Date().toISOString(),
      type: "item.completed",
      itemType: "assistant_text",
      text: "here is the research",
    });
    bus.publish(completed(helper.threadId));
    await flush();

    const runs = repos.agentTaskRuns.listByTask(repos.agentTasks.listByAssignee(helper.id)[0]!.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.executionState).toBe("completed");
    expect(runs[0]?.resultJson).toContain("here is the research");
    const deliveries = repos.agentTaskRuns.listDeliveriesForRun(runs[0]!.id);
    expect(deliveries.length).toBeGreaterThan(0);
    expect(deliveries.every((row) => row.deliveryState === "delivered" || row.deliveryState === "pending")).toBe(true);
    expect(bots.messagesFor(chief.threadId).filter((m) => m.report?.kind === "completion")).toHaveLength(1);

    const afterComplete = sendTurns.filter((s) => s.threadId === helper.threadId).length;
    expect(afterComplete).toBe(workerStarts);
    const failed = deliveries.find((row) => row.deliveryState === "failed") ?? deliveries[0]!;
    if (failed.deliveryState === "failed") {
      const retried = repos.agentTaskRuns.retryFailed({ deliveryId: failed.id, now: Date.now() });
      expect(retried.deliveryState).toBe("pending");
    }
    expect(sendTurns.filter((s) => s.threadId === helper.threadId)).toHaveLength(workerStarts);
  });
});
