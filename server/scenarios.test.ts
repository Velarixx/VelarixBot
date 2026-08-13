// P1-A harness HTTP/SSE scenario runner. Boots the real server against the
// existing fake CLIs (no live claude/codex/acp) and asserts the mechanical
// invariants on every PR: turn.completed, state transitions, option cards,
// usage totals, rule auto-resolve, peer-queue drain, memory after a turn,
// group-thread fold, and create_bot round trip.
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DISTILL_MARKER } from "./memory.ts";
import {
  FAKE_ACP_CLI,
  FAKE_CLAUDE_CLI,
  FAKE_CODEX_CLI,
  bootHarness,
  untilFile,
  type BootedHarness,
} from "./testing/harness.ts";

const COMMS_TOKEN = "test-scenario-comms-token";
const grokHappy = { instanceId: "grok", model: "fake-model" };
const grokPerm = { instanceId: "grok-perm", model: "fake-model" };
const grokPeer = { instanceId: "grok-peer", model: "fake-model" };
const grokCreate = { instanceId: "grok-create", model: "fake-model" };
const claudeSel = { instanceId: "claude", model: "claude-fake" };
const codexSel = { instanceId: "codex", model: "fake-codex-model" };

let h: BootedHarness;

async function hideVisible(): Promise<void> {
  const bots = (await h.api("GET", "/api/bots")).body.bots as Array<{ id: string; hidden?: boolean }>;
  for (const bot of bots) {
    if (!bot.hidden) await h.api("PATCH", `/api/bots/${bot.id}`, { hidden: true });
  }
}

async function addBot(name: string, modelSelection: { instanceId: string; model: string }) {
  const created = await h.api("POST", "/api/bots");
  expect(created.status).toBe(201);
  const patched = await h.api("PATCH", `/api/bots/${created.body.bot.id}`, {
    name,
    modelSelection,
    computer: "off",
  });
  return patched.body.bot as { id: string; threadId: string; name: string };
}

async function send(botId: string, text: string) {
  const res = await h.api("POST", `/api/bots/${botId}/messages`, { text });
  expect(res.status).toBe(202);
  return res;
}

function turnDone(threadId: string) {
  return (f: { kind?: string; event?: { type?: string; threadId?: string } }) =>
    f.kind === "runtime" && f.event?.type === "turn.completed" && f.event.threadId === threadId;
}

function botState(botId: string, state: string) {
  return (f: { kind?: string; bot?: { id?: string; state?: string } }) =>
    f.kind === "bot" && f.bot?.id === botId && f.bot.state === state;
}

async function publicBot(id: string) {
  const bots = (await h.api("GET", "/api/bots")).body.bots as Array<any>;
  return bots.find((b) => b.id === id);
}

beforeAll(async () => {
  h = await bootHarness({
    env: { OMB_COMMS_TOKEN: COMMS_TOKEN },
    instances: {
      grok: {
        driver: "grokAgent",
        environment: { FAKE_ACP_MODE: "happy" },
        config: { cli: FAKE_ACP_CLI, fullAuto: true },
      },
      "grok-perm": {
        driver: "grokAgent",
        environment: { FAKE_ACP_MODE: "permission" },
        config: { cli: FAKE_ACP_CLI, fullAuto: false },
      },
      "grok-peer": {
        driver: "grokAgent",
        environment: { FAKE_ACP_MODE: "ask-peer" },
        config: { cli: FAKE_ACP_CLI, fullAuto: true },
      },
      "grok-create": {
        driver: "grokAgent",
        environment: { FAKE_ACP_MODE: "create-bot" },
        config: { cli: FAKE_ACP_CLI, fullAuto: true },
      },
      claude: {
        driver: "claudeAgent",
        config: { cli: FAKE_CLAUDE_CLI, permissionMode: "bypassPermissions" },
      },
      codex: {
        driver: "codex",
        config: { cli: FAKE_CODEX_CLI, fullAuto: true },
      },
    },
  });
  const fleet = await h.api("GET", "/api/instances");
  expect(fleet.status).toBe(200);
  for (const id of ["grok", "grok-perm", "grok-peer", "grok-create", "claude", "codex"]) {
    const inst = fleet.body.instances.find((i: { instanceId: string }) => i.instanceId === id);
    expect(inst?.snapshot?.state, `${id} should be available via fake CLI`).toBe("available");
  }
  await hideVisible();
}, 30_000);

afterAll(async () => {
  await h?.stop();
});

describe("harness HTTP/SSE scenarios (fake CLIs)", () => {
  it("claude turn: completed, states, option cards, usage, memory file", async () => {
    const bot = await addBot("Claude Scout", claudeSel);
    await send(bot.id, "remember I like short answers");

    const done = await h.sse.until(turnDone(bot.threadId));
    expect(done.event).toMatchObject({ type: "turn.completed", ok: true });
    await h.sse.until(botState(bot.id, "RUNNING"));
    await h.sse.until(botState(bot.id, "DONE"));

    const after = await publicBot(bot.id);
    expect(after.state).toBe("DONE");
    expect(after.busy).toBeFalsy();
    expect(after.usage.input).toBe(12);
    expect(after.usage.output).toBe(5);
    expect(after.usage.cost).toBe(0.01);
    const reply = after.messages.findLast((m: { kind: string; role: string }) => m.kind === "text" && m.role === "bot");
    expect(reply.text).toContain("hello from fake claude");
    const card = after.messages.findLast((m: { kind: string; card?: { requestId?: string } }) => m.kind === "options" && !m.card?.requestId);
    expect(card?.card?.options?.length).toBeGreaterThanOrEqual(2);

    const memory = await untilFile(join(h.home, ".velarixbot", "memory", `${bot.id}.md`), (text) =>
      text.includes(DISTILL_MARKER) && /concise replies/i.test(text),
    );
    expect(memory).toContain(DISTILL_MARKER);
  }, 40_000);

  it("codex turn reports usage totals over SSE", async () => {
    const bot = await addBot("Codex Scout", codexSel);
    await send(bot.id, "hi");
    const done = await h.sse.until(turnDone(bot.threadId));
    expect(done.event).toMatchObject({ type: "turn.completed", ok: true });
    await h.sse.until(
      (f) =>
        f.kind === "runtime" &&
        f.event?.type === "thread.token-usage.updated" &&
        f.event.threadId === bot.threadId,
    );
    const after = await publicBot(bot.id);
    expect(after.usage.input).toBe(7);
    expect(after.usage.output).toBe(3);
    expect(after.state).toBe("DONE");
  }, 40_000);

  it("rule auto-resolves a later matching permission ask", async () => {
    const bot = await addBot("Perm Bot", grokPerm);
    await send(bot.id, "run a command");
    const opened = await h.sse.until(
      (f) => f.kind === "runtime" && f.event?.type === "request.opened" && f.event.threadId === bot.threadId,
    );
    await h.sse.until(botState(bot.id, "NEEDS_INPUT"));
    const requestId = opened.event?.requestId;
    expect(requestId).toBeTruthy();
    const allow = await h.api("POST", `/api/bots/${bot.id}/respond`, {
      requestId,
      behavior: "allow",
      always: true,
    });
    expect(allow.status).toBe(200);
    const firstDone = await h.sse.until(turnDone(bot.threadId));

    await send(bot.id, "run it again");
    const resolved = await h.sse.untilAfter(
      firstDone,
      (f) =>
        f.kind === "runtime" &&
        f.event?.type === "request.resolved" &&
        f.event.threadId === bot.threadId &&
        f.event.source === "rule",
    );
    expect(resolved.event).toMatchObject({ source: "rule" });
    await h.sse.untilAfter(resolved, turnDone(bot.threadId));
    const after = await publicBot(bot.id);
    const autoCard = after.messages.findLast(
      (m: { kind: string; card?: { requestId?: string; dismissed?: boolean; answered?: string } }) =>
        m.kind === "options" && m.card?.requestId && m.card.dismissed,
    );
    expect(autoCard?.card?.answered).toBe("allow");
    expect(after.state).toBe("DONE");
  }, 40_000);

  it("drains the peer queue once a busy helper finishes", async () => {
    const helper = await addBot("Queue Helper", grokPerm);
    const asker = await addBot("Queue Asker", grokHappy);
    const auth = { authorization: `Bearer ${COMMS_TOKEN}` };
    const ask = (message: string) =>
      h.api(
        "POST",
        "/api/internal/ask-bot",
        { fromBotId: asker.id, toBotId: helper.id, message, depth: 0, visited: [asker.id] },
        auth,
      );

    const first = ask("first in line");
    await h.sse.until(
      (f) => f.kind === "runtime" && f.event?.type === "request.opened" && f.event.threadId === helper.threadId,
    );
    await h.sse.until(botState(helper.id, "NEEDS_INPUT"));
    const second = ask("queued behind");

    const helperBot = await publicBot(helper.id);
    const card = helperBot.messages.findLast((m: { kind: string; card?: { requestId?: string } }) => m.kind === "options" && m.card?.requestId);
    expect(card?.card?.requestId).toBeTruthy();
    await h.api("POST", `/api/bots/${helper.id}/respond`, {
      requestId: card.card.requestId,
      behavior: "allow",
    });
    const firstDone = await h.sse.until(turnDone(helper.threadId));

    await h.sse.untilAfter(
      firstDone,
      (f) => f.kind === "runtime" && f.event?.type === "request.opened" && f.event.threadId === helper.threadId,
    );
    const helper2 = await publicBot(helper.id);
    const card2 = helper2.messages.findLast(
      (m: { kind: string; card?: { requestId?: string; answered?: string } }) =>
        m.kind === "options" && m.card?.requestId && !m.card.answered,
    );
    expect(card2?.card?.requestId).toBeTruthy();
    await h.api("POST", `/api/bots/${helper.id}/respond`, {
      requestId: card2.card.requestId,
      behavior: "allow",
    });

    const [a, b] = await Promise.all([first, second]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.text).toContain("hello from fake acp");
    expect(b.body.text).toContain("hello from fake acp");
    expect(a.body.error).toBeUndefined();
    expect(b.body.error).toBeUndefined();
  }, 40_000);

  it("folds a peer reply into the group thread", async () => {
    await hideVisible();
    const helper = await addBot("Helper", grokHappy);
    const asker = await addBot("Asker", grokPeer);
    await send(asker.id, "hey @Helper ping");
    await h.sse.until(turnDone(asker.threadId), 25_000);

    const askerBot = await publicBot(asker.id);
    const reply = askerBot.messages.findLast((m: { kind: string; role: string; text?: string }) => m.kind === "text" && m.role === "bot");
    expect(reply.text).toContain("Helper replied:");
    expect(reply.text).toContain("hello from fake acp");
    const groupReply = askerBot.messages.find(
      (m: { kind: string; role: string; text?: string }) => m.kind === "text" && m.role === "bot" && m.text?.startsWith("@Helper:"),
    );
    expect(groupReply?.text).toContain("hello from fake acp");
    expect(askerBot.threadParticipants).toEqual(expect.arrayContaining([asker.id, helper.id]));
    const note = askerBot.messages.find((m: { kind: string; tool?: { name?: string } }) => m.kind === "activity" && m.tool?.name?.startsWith("asked @Helper"));
    expect(note).toBeTruthy();
  }, 40_000);

  it("create_bot round-trips through agents MCP onto the sidebar", async () => {
    const maker = await addBot("Maker", grokCreate);
    await send(maker.id, "please create an ops bot");
    const added = await h.sse.until((f) => f.kind === "bot.added" && f.bot?.name === "Ops");
    expect(added.bot).toMatchObject({ name: "Ops", title: "Ops specialist", description: "Handles ops" });
    await h.sse.until(turnDone(maker.threadId));

    const makerBot = await publicBot(maker.id);
    expect(makerBot.messages.some((m: { text?: string }) => String(m.text ?? "").includes("created:"))).toBe(true);
    const note = makerBot.messages.find((m: { kind: string; tool?: { name?: string } }) => m.kind === "activity" && m.tool?.name === "created @Ops");
    expect(note).toBeTruthy();

    const roster = (await h.api("GET", "/api/bots")).body.bots as Array<{ name: string; title: string }>;
    expect(roster.some((b) => b.name === "Ops" && b.title === "Ops specialist")).toBe(true);
  }, 40_000);
});
