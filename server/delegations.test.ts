// Async peer handoff (`delegate_bot`) — fake tests only. No sleeps, no live CLI.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";

import { bindCommsStore, type CommsBus } from "./comms-visibility.ts";
import { MAX_COMMS_DEPTH } from "./comms.ts";
import { DATA_DIR } from "./config.ts";
import { defaultDbPath, openDatabase } from "./db/database.ts";
import type { SqliteDatabase } from "./db/sqlite-native.ts";
import {
  discardDelegations,
  drainDelegations,
  MAX_DELEGATION_DEPTH,
  MAX_QUEUED_PER_THREAD,
  queueDelegation,
  _pendingCount,
  _resetPending,
} from "./delegations.ts";
import { createRepositories, type Repositories } from "./repositories/index.ts";
import { createBotsService, type BotsService } from "./services/bots.ts";
import { createGroupsService, type GroupsService } from "./services/groups.ts";
import type { BotRecord } from "./store.ts";

const selection = () => ({ instanceId: "fake", model: "fake-1" });

describe("delegate_bot queue + visibility", () => {
  let db: SqliteDatabase;
  let repos: Repositories;
  let bots: BotsService;
  let groups: GroupsService;
  let from: BotRecord;
  let target: BotRecord;
  let commsBus: CommsBus;
  let broadcasts: unknown[];

  beforeEach(() => {
    _resetPending();
    rmSync(DATA_DIR, { recursive: true, force: true });
    db = openDatabase(defaultDbPath());
    repos = createRepositories(db);
    bots = createBotsService({ repos, defaultSelection: selection });
    groups = createGroupsService({ repos });
    from = bots.createBot();
    target = bots.createBot();
    bots.patchBot(from.id, { name: "Chief" });
    bots.patchBot(target.id, { name: "Helper" });
    from = bots.bot(from.id)!;
    target = bots.bot(target.id)!;
    broadcasts = [];
    commsBus = {
      store: bindCommsStore(bots, groups),
      broadcast: (payload) => {
        broadcasts.push(payload);
      },
    };
  });

  afterEach(() => {
    _resetPending();
    try {
      db.close();
    } catch {
      /* already closed */
    }
  });

  it("queues 4 ok and rejects the 5th as too_many", () => {
    for (let i = 0; i < MAX_QUEUED_PER_THREAD; i++) {
      expect(
        queueDelegation(commsBus, from, { toBotId: target.id, message: `task ${i}`, depth: 0 }),
      ).toBe("ok");
    }
    expect(_pendingCount(from.threadId)).toBe(4);
    expect(
      queueDelegation(commsBus, from, { toBotId: target.id, message: "one too many", depth: 0 }),
    ).toBe("too_many");
    expect(_pendingCount(from.threadId)).toBe(4);
  });

  it("rejects self, depth at cap, and a missing bot without queueing", () => {
    expect(queueDelegation(commsBus, from, { toBotId: from.id, message: "self", depth: 0 })).toBe("self");
    expect(
      queueDelegation(commsBus, from, { toBotId: target.id, message: "deep", depth: MAX_DELEGATION_DEPTH }),
    ).toBe("too_deep");
    expect(queueDelegation(commsBus, from, { toBotId: "ghost", message: "nope", depth: 0 })).toBe("no_target");
    expect(_pendingCount(from.threadId)).toBe(0);
  });

  it("drops a Delegated to @Name chip on the source thread", () => {
    expect(
      queueDelegation(commsBus, from, { toBotId: target.id, message: "do this", reason: "followup", depth: 0 }),
    ).toBe("ok");
    const chip = bots
      .messagesFor(from.threadId)
      .find((m) => m.kind === "activity" && m.tool?.name?.startsWith("Delegated to @"));
    expect(chip?.tool?.name).toBe("Delegated to @Helper: followup");
    expect(broadcasts.some((b) => (b as { kind?: string }).kind === "message")).toBe(true);
  });

  it("drain starts the target at depth+1 and mirrors the handoff onto source, target, and A ⇄ B", () => {
    const ran: Array<{ toBotId: string; message: string; commsDepth: number }> = [];
    queueDelegation(commsBus, from, { toBotId: target.id, message: "do this", reason: "next step", depth: 0 });
    drainDelegations(commsBus, from.threadId, (toBotId, message, commsDepth) => {
      ran.push({ toBotId, message, commsDepth });
    });
    expect(_pendingCount(from.threadId)).toBe(0);
    expect(ran).toHaveLength(1);
    expect(ran[0]!.toBotId).toBe(target.id);
    expect(ran[0]!.commsDepth).toBe(1);
    expect(ran[0]!.message).toContain("Delegated by @Chief");
    expect(ran[0]!.message).toContain("do this");
    expect(ran[0]!.message).toContain("[Reason: next step]");

    expect(bots.messagesFor(from.threadId).some((m) => m.tool?.name === "Delegated to @Helper: next step")).toBe(true);
    expect(bots.messagesFor(from.threadId).some((m) => m.tool?.name === "Messaged @Helper")).toBe(true);
    expect(bots.messagesFor(target.threadId).some((m) => m.tool?.name === "Message from @Chief")).toBe(true);

    const channel = groups.dmGroup(from.id, target.id);
    expect(channel).toBeTruthy();
    expect(channel!.name).toBe("Chief ⇄ Helper");
    expect(channel!.dm).toBe(true);
    const channelTexts = bots.messagesFor(channel!.threadId).map((m) => m.text);
    expect(channelTexts).toContain("do this");
    const chip = bots.messagesFor(from.threadId).find((m) => m.tool?.name === "Delegated to @Helper: next step");
    expect(chip?.comm?.groupId).toBe(channel!.id);
  });

  it("interrupt/fail discards the queue and drops the source chip", () => {
    queueDelegation(commsBus, from, { toBotId: target.id, message: "do this", depth: 0 });
    const chip = bots
      .messagesFor(from.threadId)
      .find((m) => m.tool?.name === "Delegated to @Helper");
    expect(chip).toBeTruthy();
    const ran: string[] = [];
    discardDelegations(commsBus, from.threadId);
    drainDelegations(commsBus, from.threadId, (toBotId) => {
      ran.push(toBotId);
    });
    expect(_pendingCount(from.threadId)).toBe(0);
    expect(ran).toEqual([]);
    const dropped = bots.messagesFor(from.threadId).find((m) => m.id === chip!.id);
    expect(dropped?.tool?.ok).toBe(false);
    expect(
      bots.messagesFor(from.threadId).some((m) => m.tool?.ok === false && m.tool.name.includes("dropped")),
    ).toBe(true);
  });

  it("a simulated restart drops the in-memory queue (nothing persisted)", () => {
    queueDelegation(commsBus, from, { toBotId: target.id, message: "left over", depth: 0 });
    expect(_pendingCount(from.threadId)).toBe(1);
    _resetPending();
    expect(_pendingCount(from.threadId)).toBe(0);
    const ran: string[] = [];
    drainDelegations(commsBus, from.threadId, (_to, message) => {
      ran.push(message);
    });
    expect(ran).toEqual([]);
  });

  it("does not change ask_bot MAX_COMMS_DEPTH", () => {
    expect(MAX_COMMS_DEPTH).toBe(2);
    expect(MAX_DELEGATION_DEPTH).toBe(1);
  });
});
