// Pre-spawn CLI checks: bare PATH names must not spawn, one missing
// engine must keep the concrete reason + switch-model card, and a
// driver that emits runtime.error then turn.completed(spawn_error)
// must not overwrite that reason with the generic fallback.
// Fake driver only. Isolated HOME. No live CLI.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";

import { DATA_DIR } from "./config.ts";
import type { RuntimeEvent } from "./contracts.ts";
import { defaultDbPath, openDatabase } from "./db/database.ts";
import type { SqliteDatabase } from "./db/sqlite-native.ts";
import { CODEX_LOGIN_NOTE, CODEX_REAUTH_OPTION, SWITCH_MODEL_OPTION, setCliSearchPathForTests } from "./engine-setup.ts";
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
import { makeFakeDriver, type FakeDriverHandle } from "./testing/fake-driver.ts";

describe("engine-unavailable turns (clean PATH, no spawn)", () => {
  let db: SqliteDatabase;
  let repos: Repositories;
  let bots: BotsService;
  let turns: TurnsService;
  let bus: EventBus;
  let fake: FakeDriverHandle;
  let sendTurns: Array<{ instanceId: string; threadId: string; text: string }>;

  async function boot(configs: Record<string, { displayName: string; cli?: string }>, defaultInstance: string) {
    rmSync(DATA_DIR, { recursive: true, force: true });
    db = openDatabase(defaultDbPath());
    repos = createRepositories(db);
    sendTurns = [];
    fake = makeFakeDriver();
    const registry = new ProviderRegistry([fake.driver]);
    const load: Record<string, { driver: string; displayName: string; config: Record<string, unknown> }> = {};
    for (const [id, entry] of Object.entries(configs)) {
      load[id] = {
        driver: "fake",
        displayName: entry.displayName,
        config: entry.cli ? { cli: entry.cli } : {},
      };
    }
    await registry.load(load);
    for (const [id, live] of fake.created) {
      live.instance.adapter.sendTurn = async (turn) => {
        sendTurns.push({ instanceId: id, threadId: turn.threadId, text: turn.text });
        return { turnId: "fake-turn" };
      };
    }
    bus = new EventBus();
    bus.attach(registry.instances());
    bots = createBotsService({
      repos,
      defaultSelection: () => ({ instanceId: defaultInstance, model: "fake-1" }),
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
    const instances: Record<string, { driver: string; config: Record<string, unknown> }> = {};
    for (const [id, entry] of Object.entries(configs)) {
      instances[id] = { driver: "fake", config: entry.cli ? { cli: entry.cli } : {} };
    }
    turns = createTurnsService({
      cfg: { instances },
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
      commsToken: "test-engine-unavailable",
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
  }

  beforeEach(() => {
    setCliSearchPathForTests("");
  });

  afterEach(() => {
    setCliSearchPathForTests(undefined);
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

  it("zero available bare CLIs never call sendTurn", async () => {
    await boot(
      {
        claude: { displayName: "Claude", cli: "claude" },
        codex: { displayName: "Codex", cli: "codex" },
        grok: { displayName: "Grok", cli: "grok" },
        gemini: { displayName: "Gemini", cli: "gemini" },
      },
      "claude",
    );
    const bot = bots.createBot();
    await turns.startTurn(bot.id, "hello?");
    await flush();
    expect(sendTurns).toEqual([]);
    const settled = bots.bot(bot.id)!;
    expect(settled.state).toBe("BLOCKED");
    expect(settled.busy).toBe(false);
    expect(settled.stateCode).toBe("no_engines");
    expect(settled.stateDetail).not.toMatch(/spawn_error/i);
    const card = bots.messagesFor(bot.threadId).find((m) => m.card?.requestType === "setup")?.card;
    expect(card).toBeTruthy();
    expect(card?.options.join("\n")).toMatch(/claude/i);
    expect(card?.options[0]).not.toBe(SWITCH_MODEL_OPTION);
  });

  it("one missing engine keeps the concrete CLI reason and leads with switch-model", async () => {
    await boot(
      {
        claude: { displayName: "Claude", cli: "claude" },
        helper: { displayName: "Helper" },
      },
      "claude",
    );
    const bot = bots.createBot();
    bots.patchBot(bot.id, { modelSelection: { instanceId: "claude", model: "fake-1" } });
    await turns.startTurn(bot.id, "hello?");
    await flush();
    expect(sendTurns).toEqual([]);
    const settled = bots.bot(bot.id)!;
    expect(settled.state).toBe("BLOCKED");
    expect(settled.stateCode).toBe("engine_unavailable");
    expect(settled.stateDetail).toContain("`claude` CLI not found");
    expect(settled.stateDetail).not.toMatch(/The selected engine CLI is not available/);
    expect(settled.stateDetail).not.toMatch(/spawn_error/i);
    const card = bots.messagesFor(bot.threadId).find((m) => m.card?.requestType === "setup")?.card;
    expect(card?.options[0]).toBe(SWITCH_MODEL_OPTION);
  });

  it("turn.completed(spawn_error) keeps the runtime.error spawn reason", async () => {
    await boot({ fake: { displayName: "Fake" } }, "fake");
    const live = fake.created.get("fake")!;
    live.instance.adapter.sendTurn = async (turn) => {
      sendTurns.push({ instanceId: "fake", threadId: turn.threadId, text: turn.text });
      const base = {
        eventId: "ev",
        provider: "fake" as const,
        providerInstanceId: "fake",
        threadId: turn.threadId,
        createdAt: new Date().toISOString(),
      };
      live.emit({
        ...base,
        eventId: "ev-err",
        type: "runtime.error",
        message: "spawn failed: spawn ENOENT claude",
      } satisfies RuntimeEvent);
      live.emit({
        ...base,
        eventId: "ev-done",
        type: "turn.completed",
        ok: false,
        stopReason: "spawn_error",
      } satisfies RuntimeEvent);
      return { turnId: "fake-turn" };
    };
    const bot = bots.createBot();
    await turns.startTurn(bot.id, "hello?");
    await flush();
    expect(sendTurns).toHaveLength(1);
    const settled = bots.bot(bot.id)!;
    expect(settled.state).toBe("BLOCKED");
    expect(settled.stateCode).toBe("spawn_error");
    expect(settled.stateDetail).toContain("ENOENT");
    expect(settled.stateDetail).not.toMatch(/The selected engine CLI is not available/);
    expect(settled.stateDetail).not.toMatch(/spawn_error/i);
  });

  it("Codex refresh-token runtime.error is auth_required + loginNote with a sign-in card", async () => {
    await boot({ fake: { displayName: "Codex" } }, "fake");
    const live = fake.created.get("fake")!;
    const raw =
      "Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.";
    live.instance.adapter.sendTurn = async (turn) => {
      sendTurns.push({ instanceId: "fake", threadId: turn.threadId, text: turn.text });
      const base = {
        eventId: "ev",
        provider: "fake" as const,
        providerInstanceId: "fake",
        threadId: turn.threadId,
        createdAt: new Date().toISOString(),
      };
      live.emit({
        ...base,
        eventId: "ev-err",
        type: "runtime.error",
        message: raw,
      } satisfies RuntimeEvent);
      live.emit({
        ...base,
        eventId: "ev-done",
        type: "turn.completed",
        ok: false,
        stopReason: "rpc_error",
      } satisfies RuntimeEvent);
      return { turnId: "fake-turn" };
    };
    const bot = bots.createBot();
    await turns.startTurn(bot.id, "hello?");
    await flush();
    expect(sendTurns).toHaveLength(1);
    const settled = bots.bot(bot.id)!;
    expect(settled.state).toBe("BLOCKED");
    expect(settled.stateCode).toBe("auth_required");
    expect(settled.stateDetail).toBe(CODEX_LOGIN_NOTE);
    expect(settled.stateDetail).toMatch(/codex logout/);
    expect(settled.stateDetail).toMatch(/codex login/);
    expect(settled.stateDetail).not.toMatch(/refresh token was already used/i);
    expect(settled.stateDetail).not.toMatch(/Please log out and sign in again/i);
    const card = bots.messagesFor(bot.threadId).find((m) => m.card?.requestType === "setup")?.card;
    expect(card?.options[0]).toBe(SWITCH_MODEL_OPTION);
    expect(card?.options).toContain(CODEX_REAUTH_OPTION);
    expect(card?.options.join("\n")).toMatch(/codex logout/);
    expect(card?.options.join("\n")).toMatch(/codex login/);
    expect(card?.subtitle).toBe(CODEX_LOGIN_NOTE);
  });

  it("a fake instance with no cli still calls sendTurn (does not treat empty PATH as zero engines)", async () => {
    await boot({ fake: { displayName: "Fake" } }, "fake");
    const bot = bots.createBot();
    await turns.startTurn(bot.id, "coordinate");
    await flush();
    expect(sendTurns).toHaveLength(1);
    expect(sendTurns[0]!.threadId).toBe(bot.threadId);
    expect(bots.bot(bot.id)!.state).toBe("RUNNING");
  });
});
