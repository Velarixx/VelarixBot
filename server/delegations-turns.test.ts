// Drain-on-completed / discard-on-interrupt / ask_bot-still-waits.
// Fake driver only. Isolated HOME. No sleeps, no live CLI.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";

import { bindCommsStore } from "./comms-visibility.ts";
import { DATA_DIR } from "./config.ts";
import type { RuntimeEvent } from "./contracts.ts";
import { defaultDbPath, openDatabase } from "./db/database.ts";
import type { SqliteDatabase } from "./db/sqlite-native.ts";
import { queueDelegation, _pendingCount, _resetPending } from "./delegations.ts";
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

describe("delegate_bot drain through turns", () => {
  let db: SqliteDatabase;
  let repos: Repositories;
  let bots: BotsService;
  let turns: TurnsService;
  let bus: EventBus;
  let sendTurns: Array<{ threadId: string; text: string; system?: string }>;

  beforeEach(async () => {
    _resetPending();
    rmSync(DATA_DIR, { recursive: true, force: true });
    db = openDatabase(defaultDbPath());
    repos = createRepositories(db);
    sendTurns = [];

    const fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    await registry.load({ fake: { driver: "fake", displayName: "Fake" } });
    const live = fake.created.get("fake")!;
    live.instance.adapter.capabilities = { sessionModelSwitch: "unsupported", agentsMcp: true };
    live.instance.adapter.sendTurn = async (turn) => {
      sendTurns.push({ threadId: turn.threadId, text: turn.text, system: turn.system });
      return { turnId: "fake-turn" };
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
      eventId: `ev-done-${threadId}`,
      provider: "fake",
      providerInstanceId: "fake",
      threadId,
      createdAt: new Date().toISOString(),
      type: "turn.completed",
      ok,
    };
  }

  it("drain after completed starts the target; source chip + A⇄B + target all show the handoff", async () => {
    const source = bots.createBot();
    const peer = bots.createBot();
    bots.patchBot(source.id, { name: "Chief" });
    bots.patchBot(peer.id, { name: "Helper" });
    const chief = bots.bot(source.id)!;
    const helper = bots.bot(peer.id)!;

    await turns.startTurn(chief.id, "coordinate");
    await flush();
    expect(sendTurns.map((s) => s.threadId)).toEqual([chief.threadId]);
    expect(sendTurns[0]!.system).toContain("delegate_bot");
    expect(sendTurns[0]!.system).toMatch(/do not wait/i);
    expect(sendTurns[0]!.system).not.toMatch(/wait for the teammate's actual reply/i);

    const groups = createGroupsService({ repos });
    const commsBus = { store: bindCommsStore(bots, groups), broadcast: () => {} };
    expect(queueDelegation(commsBus, chief, { toBotId: helper.id, message: "research this", depth: 0 })).toBe("ok");
    expect(_pendingCount(chief.threadId)).toBe(1);

    bus.publish(completed(chief.threadId));
    await flush();

    expect(_pendingCount(chief.threadId)).toBe(0);
    const peerTurns = sendTurns.filter((s) => s.threadId === helper.threadId);
    expect(peerTurns).toHaveLength(1);
    expect(peerTurns[0]!.text).toContain("Delegated by @Chief");
    expect(peerTurns[0]!.text).toContain("research this");

    expect(bots.messagesFor(chief.threadId).some((m) => m.tool?.name === "Delegated to @Helper")).toBe(true);
    expect(bots.messagesFor(chief.threadId).some((m) => m.tool?.name === "Messaged @Helper")).toBe(true);
    expect(bots.messagesFor(helper.threadId).some((m) => m.tool?.name === "Message from @Chief")).toBe(true);
    const channel = groups.dmGroup(chief.id, helper.id);
    expect(channel?.name).toBe("Chief ⇄ Helper");
    expect(bots.messagesFor(channel!.threadId).some((m) => m.text === "research this")).toBe(true);

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
    expect(bots.messagesFor(channel!.threadId).some((m) => m.text === "here is the research")).toBe(true);
  });

  it("interrupt discards the queue and does not start the target", async () => {
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
    queueDelegation(commsBus, chief, { toBotId: helper.id, message: "research this", depth: 0 });
    expect(_pendingCount(chief.threadId)).toBe(1);

    await turns.interrupt(chief.id);
    expect(_pendingCount(chief.threadId)).toBe(0);
    expect(sendTurns.filter((s) => s.threadId === helper.threadId)).toEqual([]);
    const chip = bots.messagesFor(chief.threadId).find((m) => m.tool?.name === "Delegated to @Helper");
    expect(chip?.tool?.ok).toBe(false);
  });

  it("ask_bot still waits for the peer reply", async () => {
    const asker = bots.createBot();
    const peer = bots.createBot();
    bots.patchBot(asker.id, { name: "Chief" });
    bots.patchBot(peer.id, { name: "Helper" });
    const helper = bots.bot(peer.id)!;

    let settled = false;
    const reply = turns.askBotQueued(helper.id, "ping", 0, { fromBotId: asker.id, visited: [asker.id] });
    void reply.then(() => {
      settled = true;
    });
    await flush();
    expect(sendTurns.some((s) => s.threadId === helper.threadId)).toBe(true);
    expect(settled).toBe(false);

    bus.publish(completed(helper.threadId));
    await expect(reply).resolves.toMatch(/finished without a text reply/);
    expect(settled).toBe(true);
  });
});
