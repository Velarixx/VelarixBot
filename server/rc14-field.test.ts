// rc.14 field-feedback regressions, end to end against the real harness
// server and the real agents-proxy (spawned exactly the way a driver mounts
// it — process.execPath + entry + env, no shell).
//
//   Item 1 — sidebar rename / list_bots identity: the field trace was
//   update_bot "succeeding" while the bot then vanished from list_bots
//   ("No other bots in this workspace yet.") and from update_bot itself
//   ("no such bot"). The mechanism was a persisted record a later read
//   could not load being silently dropped by the repository. These tests
//   pin the whole done-when list: update persists, SSE `kind:"bot"` fans
//   out for the sidebar, list_bots keeps the bot, the id stays stable, a
//   second update works, and the caller's self-exclusion is consistent.
//
//   Item 2 — per-bot Always allow: the settings toggle auto-resolves
//   routine permission asks for THIS bot only (P0.1 stays binding: nothing
//   persisted for Allow-once, no workspace wildcard, credential asks still
//   card, Require approval wins).
import { spawn, type ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FAKE_ACP_CLI, FAKE_CODEX_CLI, bootHarness, type BootedHarness, type SseFrame } from "./testing/harness.ts";

const PROXY = join(dirname(fileURLToPath(import.meta.url)), "drivers", "agents-proxy.ts");
const COMMS_TOKEN = "test-rc14-comms-token";

let h: BootedHarness;
let proxy: ChildProcess | null = null;
const pending = new Map<number, (msg: any) => void>();
let nextId = 100;

function rpc(method: string, params?: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, resolve);
    proxy!.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`${method} timed out`));
    }, 15_000).unref?.();
  });
}
const callTool = async (name: string, args: unknown): Promise<{ text: string; isError?: boolean }> => {
  const res = await rpc("tools/call", { name, arguments: args });
  return { text: res.result.content[0].text, isError: res.result.isError };
};

function spawnProxyAs(botId: string): void {
  proxy = spawn(process.execPath, [PROXY], {
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      OMB_HARNESS_URL: h.base,
      OMB_BOT_ID: botId,
      OMB_COMMS_TOKEN: COMMS_TOKEN,
      OMB_TURN_DEPTH: "0",
    },
    stdio: ["pipe", "pipe", "inherit"],
  });
  let buf = "";
  proxy.stdout!.on("data", (c) => {
    buf += c;
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      pending.get(msg.id)?.(msg);
      pending.delete(msg.id);
    }
  });
}

async function addBot(name: string, modelSelection: { instanceId: string; model: string }) {
  const created = await h.api("POST", "/api/bots");
  expect(created.status).toBe(201);
  const patched = await h.api("PATCH", `/api/bots/${created.body.bot.id}`, { name, modelSelection, computer: "off" });
  expect(patched.status).toBe(200);
  return patched.body.bot as { id: string; threadId: string; name: string };
}

async function roster() {
  return (await h.api("GET", "/api/bots")).body.bots as Array<any>;
}

const turnDone = (threadId: string) => (f: SseFrame) =>
  f.kind === "runtime" && f.event?.type === "turn.completed" && f.event.threadId === threadId;

beforeAll(async () => {
  h = await bootHarness({
    env: { OMB_COMMS_TOKEN: COMMS_TOKEN },
    instances: {
      "grok-perm": {
        driver: "grokAgent",
        environment: { FAKE_ACP_MODE: "permission" },
        config: { cli: FAKE_ACP_CLI, fullAuto: false },
      },
      "grok-cred": {
        driver: "grokAgent",
        environment: { FAKE_ACP_MODE: "credential" },
        config: { cli: FAKE_ACP_CLI, fullAuto: false },
      },
      codex: {
        driver: "codex",
        config: { cli: FAKE_CODEX_CLI, fullAuto: false },
      },
    },
  });
}, 30_000);

afterAll(async () => {
  proxy?.kill();
  await h?.stop();
});

describe("item 1 — update_bot / list_bots identity (rc.14 field trace)", () => {
  it("update_bot persists, the sidebar SSE frame fans out, list_bots keeps the bot, the id is stable, and a second update works", async () => {
    const caller = await addBot("Coordinator", { instanceId: "grok-perm", model: "fake-model" });
    const created = await h.api("POST", "/api/bots");
    const target = created.body.bot as { id: string; name: string };
    expect(target.name).toBe("New Bot");

    spawnProxyAs(caller.id);
    await rpc("initialize", { protocolVersion: "2024-11-05" });

    // step 1 — list_bots sees the target (and hides the caller: identity)
    const list1 = await callTool("list_bots", {});
    expect(list1.text).toContain("New Bot");
    expect(list1.text).toContain(target.id);
    expect(list1.text).not.toContain(caller.id);

    // step 2 — update_bot renames it
    const upd1 = await callTool("update_bot", {
      bot_id: target.id,
      name: "Chief of Staff",
      title: "Personal Chief of Staff",
      description: "Runs the office",
    });
    expect(upd1.isError).toBeFalsy();
    expect(upd1.text).toContain("Chief of Staff");
    expect(upd1.text).toContain(target.id);

    // step 3 — the sidebar updates immediately: a `kind:"bot"` SSE frame
    // with the target's id and the new name reaches every client
    const frame = await h.sse.until((f) => f.kind === "bot" && f.bot?.id === target.id && f.bot.name === "Chief of Staff");
    expect(frame.bot).toMatchObject({ id: target.id, name: "Chief of Staff" });

    // step 4 — list_bots still returns the bot, renamed, same id
    const list2 = await callTool("list_bots", {});
    expect(list2.text).toContain("Chief of Staff");
    expect(list2.text).toContain(target.id);
    expect(list2.text).not.toContain("No other bots");
    // caller self-exclusion is consistent before and after the mutation
    expect(list2.text).not.toContain(caller.id);

    // step 5 — a second update_bot on the same id works
    const upd2 = await callTool("update_bot", { bot_id: target.id, title: "Chief of Staff v2" });
    expect(upd2.isError).toBeFalsy();

    // persisted, addressable, id stable
    const after = (await roster()).find((b) => b.id === target.id);
    expect(after).toBeTruthy();
    expect(after).toMatchObject({
      id: target.id,
      name: "Chief of Staff",
      title: "Chief of Staff v2",
      description: "Runs the office",
    });
  }, 30_000);

  it("a malformed PATCH is a 400, never a silently-vanished bot (the field failure mechanism)", async () => {
    const bot = await addBot("Sturdy", { instanceId: "grok-perm", model: "fake-model" });

    const badName = await h.api("PATCH", `/api/bots/${bot.id}`, { name: 123 });
    expect(badName.status).toBe(400);
    expect(badName.body.error).toContain("invalid bot patch");

    const badSelection = await h.api("PATCH", `/api/bots/${bot.id}`, { modelSelection: "gpt-5.6-terra" });
    expect(badSelection.status).toBe(400);

    const badFlag = await h.api("PATCH", `/api/bots/${bot.id}`, { alwaysAllow: "yes" });
    expect(badFlag.status).toBe(400);

    // the bot never vanished: still listed, still addressable, unchanged
    const still = (await roster()).find((b) => b.id === bot.id);
    expect(still).toMatchObject({ id: bot.id, name: "Sturdy" });
    const good = await h.api("PATCH", `/api/bots/${bot.id}`, { name: "Sturdy Two" });
    expect(good.status).toBe(200);
    expect(good.body.bot.name).toBe("Sturdy Two");
  });
});

describe("item 2 — per-bot Always allow settings toggle", () => {
  it("auto-allows a routine ask without a card, persists no rule, and stays scoped to this bot", async () => {
    const bot = await addBot("Auto Bot", { instanceId: "grok-perm", model: "fake-model" });
    const on = await h.api("PATCH", `/api/bots/${bot.id}`, { alwaysAllow: true });
    expect(on.status).toBe(200);
    expect(on.body.bot.alwaysAllow).toBe(true);

    await h.api("POST", `/api/bots/${bot.id}/messages`, { text: "run a command" });
    const resolved = await h.sse.until(
      (f) =>
        f.kind === "runtime" &&
        f.event?.type === "request.resolved" &&
        f.event.threadId === bot.threadId &&
        f.event.source === "rule",
    );
    expect(resolved.event).toMatchObject({ behavior: "allow", source: "rule" });
    await h.sse.until(turnDone(bot.threadId));

    // no permission card ever reached the transcript…
    const after = (await roster()).find((b) => b.id === bot.id);
    const permissionCards = (after.messages as Array<any>).filter(
      (m) => m.kind === "options" && m.card?.requestId,
    );
    expect(permissionCards).toEqual([]);
    // …and NOTHING was persisted: no per-bot rule, no workspace wildcard
    expect((await h.api("GET", `/api/bots/${bot.id}/approvals`)).body.rules).toEqual([]);

    // scoped to this bot: a sibling on the same instance still cards
    const sibling = await addBot("Manual Bot", { instanceId: "grok-perm", model: "fake-model" });
    await h.api("POST", `/api/bots/${sibling.id}/messages`, { text: "run a command" });
    const opened = await h.sse.until(
      (f) => f.kind === "runtime" && f.event?.type === "request.opened" && f.event.threadId === sibling.threadId,
    );
    expect(opened.event?.requestId).toBeTruthy();
    await h.api("POST", `/api/bots/${sibling.id}/respond`, { requestId: opened.event?.requestId, behavior: "deny" });
    await h.sse.until(turnDone(sibling.threadId));
  }, 30_000);

  it("Require approval wins over Always allow — the ask still cards", async () => {
    const bot = await addBot("Careful Bot", { instanceId: "grok-perm", model: "fake-model" });
    await h.api("PATCH", `/api/bots/${bot.id}`, { alwaysAllow: true, requireApproval: true });

    await h.api("POST", `/api/bots/${bot.id}/messages`, { text: "run a command" });
    const opened = await h.sse.until(
      (f) => f.kind === "runtime" && f.event?.type === "request.opened" && f.event.threadId === bot.threadId,
    );
    expect(opened.event?.requestId).toBeTruthy();
    await h.api("POST", `/api/bots/${bot.id}/respond`, { requestId: opened.event?.requestId, behavior: "deny" });
    await h.sse.until(turnDone(bot.threadId));
  }, 30_000);

  it("credential/sign-in asks still card under Always allow", async () => {
    const bot = await addBot("Cred Bot", { instanceId: "grok-cred", model: "fake-model" });
    await h.api("PATCH", `/api/bots/${bot.id}`, { alwaysAllow: true });

    await h.api("POST", `/api/bots/${bot.id}/messages`, { text: "log in somewhere" });
    const opened = await h.sse.until(
      (f) => f.kind === "runtime" && f.event?.type === "request.opened" && f.event.threadId === bot.threadId,
    );
    expect(opened.event?.requestType).toBe("credential");
    await h.api("POST", `/api/bots/${bot.id}/respond`, { requestId: opened.event?.requestId, behavior: "allow" });
    await h.sse.until(turnDone(bot.threadId));
  }, 30_000);

  it("update_bot can flip Always allow for a sidebar bot (CoS parity), still no persisted rule", async () => {
    const caller = await addBot("Flipper", { instanceId: "grok-perm", model: "fake-model" });
    const target = await addBot("Flip Target", { instanceId: "grok-perm", model: "fake-model" });
    proxy?.kill();
    spawnProxyAs(caller.id);
    await rpc("initialize", { protocolVersion: "2024-11-05" });

    const on = await callTool("update_bot", { bot_id: target.id, always_allow: true });
    expect(on.isError).toBeFalsy();
    expect(on.text).toContain("Always allow is now on");
    expect((await roster()).find((b) => b.id === target.id)?.alwaysAllow).toBe(true);
    expect((await h.api("GET", `/api/bots/${target.id}/approvals`)).body.rules).toEqual([]);

    const off = await callTool("update_bot", { bot_id: target.id, always_allow: false });
    expect(off.isError).toBeFalsy();
    expect(off.text).toContain("Always allow is now off");
    expect((await roster()).find((b) => b.id === target.id)?.alwaysAllow).toBeFalsy();
  }, 30_000);

  it("local computer and Always allow never combine (same 409 class as provider full-auto)", async () => {
    const bot = await addBot("Local Bot", { instanceId: "codex", model: "fake-codex-model" });
    const local = await h.api("PATCH", `/api/bots/${bot.id}`, { computer: "local" });
    expect(local.status).toBe(200);

    // toggling Always allow on a local-computer bot is refused…
    const denied = await h.api("PATCH", `/api/bots/${bot.id}`, { alwaysAllow: true });
    expect(denied.status).toBe(409);
    expect(denied.body.error).toMatch(/local computer.*Always allow/);

    // …including through the internal update-bot (CoS) surface
    const internal = await h.api(
      "POST",
      "/api/internal/update-bot",
      { bot_id: bot.id, always_allow: true },
      { authorization: `Bearer ${COMMS_TOKEN}` },
    );
    expect(internal.status).toBe(409);

    // and the reverse order: moving an Always-allow bot onto the local computer
    await h.api("PATCH", `/api/bots/${bot.id}`, { computer: "off" });
    expect((await h.api("PATCH", `/api/bots/${bot.id}`, { alwaysAllow: true })).status).toBe(200);
    const backToLocal = await h.api("PATCH", `/api/bots/${bot.id}`, { computer: "local" });
    expect(backToLocal.status).toBe(409);
  });
});
