// #116 / #119 / #120: lead workflow, delegated reports, assigned tasks.
// Fake driver only. Isolated HOME. No sleeps, no live CLI.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";

import { autoResolvePermission } from "./approvals.ts";
import { agentTasks, configureAgentTasks } from "./agent-tasks.ts";
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
import { AUTONOMY_CONTINUE_PROMPT, AUTONOMY_STOP, MAX_AUTONOMY_HOPS } from "./workflow.ts";

const selection = () => ({ instanceId: "fake", model: "fake-1" });

describe("lead workflow + reports + assigned tasks", () => {
  let db: SqliteDatabase;
  let repos: Repositories;
  let bots: BotsService;
  let turns: TurnsService;
  let bus: EventBus;
  let sendTurns: Array<{ threadId: string; text: string; system?: string; requireApproval?: boolean }>;

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
      sendTurns.push({
        threadId: turn.threadId,
        text: turn.text,
        system: turn.system,
        requireApproval: turn.requireApproval,
      });
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
      commsToken: "test-lead-workflow",
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
    await Promise.resolve();
  }

  function completed(threadId: string, ok = true, stopReason?: string): RuntimeEvent {
    return {
      eventId: `ev-done-${threadId}-${ok}`,
      provider: "fake",
      providerInstanceId: "fake",
      threadId,
      createdAt: new Date().toISOString(),
      type: "turn.completed",
      ok,
      ...(stopReason ? { stopReason } : {}),
    };
  }

  function assistantText(threadId: string, text: string): RuntimeEvent {
    return {
      eventId: `ev-text-${threadId}-${text.slice(0, 8)}`,
      provider: "fake",
      providerInstanceId: "fake",
      threadId,
      createdAt: new Date().toISOString(),
      type: "item.completed",
      itemType: "assistant_text",
      text,
    };
  }

  async function pair() {
    const source = bots.createBot();
    const peer = bots.createBot();
    bots.patchBot(source.id, { name: "Chief" });
    bots.patchBot(peer.id, { name: "Helper" });
    return { chief: bots.bot(source.id)!, helper: bots.bot(peer.id)! };
  }

  it("lead shows working → waiting-for-agent → completed, with reports in order and no duplicates", async () => {
    const { chief, helper } = await pair();
    await turns.startTurn(chief.id, "coordinate");
    await flush();
    expect(bots.bot(chief.id)?.workflowStatus).toBe("working");

    const groups = createGroupsService({ repos });
    const commsBus = { store: bindCommsStore(bots, groups), broadcast: () => {} };
    expect(queueDelegation(commsBus, chief, { toBotId: helper.id, message: "research this", reason: "next step", depth: 0 })).toBe("ok");

    const assigned = bots.messagesFor(helper.threadId).find((m) => m.text === "research this");
    expect(assigned?.from?.name).toBe("Chief");
    expect(assigned?.task?.id).toBeTruthy();
    expect(agentTasks().listByAssignee(helper.id)[0]?.state).toBe("pending");

    bus.publish(completed(chief.threadId));
    await flush();

    const lead = bots.bot(chief.id)!;
    expect(lead.workflowStatus).toBe("waiting");
    expect(lead.workflowWaitingFor).toEqual([{ botId: helper.id, name: "Helper" }]);
    expect(agentTasks().listByAssignee(helper.id)[0]?.state).toBe("active");

    const leadMessages = bots.messagesFor(chief.threadId);
    const kinds = leadMessages.filter((m) => m.report).map((m) => m.report!.kind);
    expect(kinds).toEqual(["handoff", "progress"]);
    expect(leadMessages.filter((m) => m.report?.kind === "handoff")).toHaveLength(1);
    expect(leadMessages.filter((m) => m.report?.kind === "progress")).toHaveLength(1);

    bus.publish(assistantText(helper.threadId, "here is the research"));
    bus.publish(completed(helper.threadId));
    await flush();

    const after = bots.messagesFor(chief.threadId);
    expect(after.filter((m) => m.report?.kind === "completion")).toHaveLength(1);
    const completion = after.find((m) => m.report?.kind === "completion");
    expect(completion?.from?.name).toBe("Helper");
    expect(completion?.from?.botId).toBe(helper.id);
    expect(completion?.text).toContain("here is the research");
    expect(after.map((m) => m.report?.kind).filter(Boolean)).toEqual(["handoff", "progress", "completion"]);

    expect(agentTasks().listByAssignee(helper.id)[0]).toMatchObject({
      state: "completed",
      result: "here is the research",
    });
    expect(bots.bot(chief.id)?.workflowStatus).toBe("completed");
    expect(bots.bot(chief.id)?.workflowStopReason).toBe(AUTONOMY_STOP.off);
  });

  it("full-autonomy continues the lead without a user prompt and still honors requireApproval", async () => {
    const { chief, helper } = await pair();
    bots.patchBot(chief.id, { fullAutonomy: true, requireApproval: true });
    expect(bots.bot(chief.id)?.fullAutonomy).toBe(true);
    expect(
      autoResolvePermission(bots.bot(chief.id)!, "shell", "git status"),
    ).toBeNull();

    await turns.startTurn(chief.id, "coordinate");
    await flush();
    expect(sendTurns[0]?.requireApproval).toBe(true);
    expect(sendTurns[0]?.system).toMatch(/Full-autonomy is on/i);

    const groups = createGroupsService({ repos });
    const commsBus = { store: bindCommsStore(bots, groups), broadcast: () => {} };
    queueDelegation(commsBus, chief, { toBotId: helper.id, message: "research this", depth: 0 });
    bus.publish(completed(chief.threadId));
    await flush();

    bus.publish(assistantText(helper.threadId, "here is the research"));
    bus.publish(completed(helper.threadId));
    await flush();

    const continueTurns = sendTurns.filter((row) => row.threadId === chief.threadId && row.text === AUTONOMY_CONTINUE_PROMPT);
    expect(continueTurns).toHaveLength(1);
    expect(continueTurns[0]?.requireApproval).toBe(true);
    expect(bots.messagesFor(chief.threadId).some((m) => m.tool?.name === "Continuing autonomously")).toBe(true);
    expect(bots.bot(chief.id)?.workflowStatus).toBe("working");
    expect(bots.bot(chief.id)?.workflowAutonomyHops).toBe(1);

    bus.publish(completed(chief.threadId));
    await flush();
    expect(bots.bot(chief.id)?.workflowStatus).toBe("completed");
    expect(bots.bot(chief.id)?.workflowStopReason).toBe(AUTONOMY_STOP.completed);
  });

  it("stops at the configured safety boundary and explains why", async () => {
    const { chief, helper } = await pair();
    bots.patchBot(chief.id, { fullAutonomy: true });
    await turns.startTurn(chief.id, "coordinate");
    await flush();
    const groups = createGroupsService({ repos });
    const commsBus = { store: bindCommsStore(bots, groups), broadcast: () => {} };
    queueDelegation(commsBus, chief, { toBotId: helper.id, message: "research this", depth: 0 });
    bus.publish(completed(chief.threadId));
    await flush();
    bots.patchBot(chief.id, { workflowAutonomyHops: MAX_AUTONOMY_HOPS });
    bus.publish(assistantText(helper.threadId, "done"));
    bus.publish(completed(helper.threadId));
    await flush();

    expect(sendTurns.filter((row) => row.text === AUTONOMY_CONTINUE_PROMPT)).toHaveLength(0);
    expect(bots.bot(chief.id)?.workflowStatus).toBe("paused");
    expect(bots.bot(chief.id)?.workflowStopReason).toBe(AUTONOMY_STOP.boundary);
  });

  it("a peer blocker reports into the lead feed and marks the task blocked", async () => {
    const { chief, helper } = await pair();
    await turns.startTurn(chief.id, "coordinate");
    await flush();
    const groups = createGroupsService({ repos });
    const commsBus = { store: bindCommsStore(bots, groups), broadcast: () => {} };
    queueDelegation(commsBus, chief, { toBotId: helper.id, message: "research this", depth: 0 });
    bus.publish(completed(chief.threadId));
    await flush();

    bus.publish({
      eventId: "ev-err",
      provider: "fake",
      providerInstanceId: "fake",
      threadId: helper.threadId,
      createdAt: new Date().toISOString(),
      type: "runtime.error",
      message: "spawn failed",
    });
    await flush();

    const blocker = bots.messagesFor(chief.threadId).find((m) => m.report?.kind === "blocker");
    expect(blocker?.from?.name).toBe("Helper");
    expect(agentTasks().listByAssignee(helper.id)[0]?.state).toBe("blocked");
    expect(bots.bot(chief.id)?.workflowStatus).toBe("blocked");
    expect(bots.bot(chief.id)?.workflowStopReason).toMatch(/@Helper/);
  });

  it("reload reconstructs tasks and workflow from SQLite", async () => {
    const { chief, helper } = await pair();
    bots.patchBot(chief.id, {
      fullAutonomy: true,
      workflowStatus: "waiting",
      workflowWaitingFor: [{ botId: helper.id, name: "Helper" }],
      workflowStopReason: AUTONOMY_STOP.off,
    });
    const task = agentTasks().insert({
      id: "task-reload",
      assigneeBotId: helper.id,
      fromBotId: chief.id,
      fromName: "Chief",
      sourceThreadId: chief.threadId,
      assignment: "research this",
      state: "active",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    db.close();
    db = openDatabase(defaultDbPath());
    repos = createRepositories(db);
    configureAgentTasks(repos.agentTasks);
    const reloadedBots = createBotsService({ repos, defaultSelection: selection });
    const reloadedLead = reloadedBots.bot(chief.id);
    expect(reloadedLead?.fullAutonomy).toBe(true);
    expect(reloadedLead?.workflowStatus).toBe("waiting");
    expect(reloadedLead?.workflowWaitingFor).toEqual([{ botId: helper.id, name: "Helper" }]);
    expect(agentTasks().get(task.id)?.state).toBe("active");
    expect(agentTasks().get(task.id)?.assignment).toBe("research this");
  });
});
