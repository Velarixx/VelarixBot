// P1.1 acceptance over the real HTTP surface (fake claude CLI, no live
// vendors):
//   1. Box removed via config → local mode intact, "cloud"/"box" bindings
//      are explicit 409s, and a configured fake provider drives the whole
//      Computer panel surface end to end.
//   2. Default config, first run → no Box token anywhere: bots work, the
//      panel reports unconfigured, and binding a bot to the box provider
//      neither prompts nor fails.
import { describe, expect, it, beforeAll, afterAll } from "vitest";

import { FAKE_CLAUDE_CLI, bootHarness, type BootedHarness } from "../testing/harness.ts";

const instances = {
  claude: {
    driver: "claudeAgent",
    config: { cli: FAKE_CLAUDE_CLI, permissionMode: "bypassPermissions" },
  },
};
const selection = { instanceId: "claude", model: "claude-fake" };

describe("box removed via config (computer.providers without box)", () => {
  let h: BootedHarness;

  beforeAll(async () => {
    h = await bootHarness({
      instances,
      // authored map replaces the bundled default: fake in, box GONE
      config: { computer: { providers: { fake: { kind: "fake" } } } },
    });
  }, 30_000);

  afterAll(async () => {
    await h?.stop();
  });

  async function freshBot(): Promise<{ id: string }> {
    const created = await h.api("POST", "/api/bots");
    expect(created.status).toBe(201);
    const patched = await h.api("PATCH", `/api/bots/${created.body.bot.id}`, { modelSelection: selection });
    expect(patched.status).toBe(200);
    return patched.body.bot;
  }

  it("rejects the box binding (and its legacy cloud alias) explicitly — no silent failover", async () => {
    const bot = await freshBot();
    for (const value of ["cloud", "box"]) {
      const denied = await h.api("PATCH", `/api/bots/${bot.id}`, { computer: value });
      expect(denied.status).toBe(409);
      expect(denied.body.error).toMatch(/unknown computer provider/);
    }
  });

  it("keeps local mode fully intact", async () => {
    const bot = await freshBot();
    const patched = await h.api("PATCH", `/api/bots/${bot.id}`, { computer: "local" });
    expect(patched.status).toBe(200);
    expect(patched.body.bot.computer).toBe("local");
  });

  it("drives the whole panel surface through the configured fake provider", async () => {
    const bot = await freshBot();
    const bound = await h.api("PATCH", `/api/bots/${bot.id}`, { computer: "fake" });
    expect(bound.status).toBe(200);
    expect(bound.body.bot.computer).toBe("fake");

    const before = await h.api("GET", `/api/bots/${bot.id}/computer`);
    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({ configured: true, provider: "fake", box: null });

    const provisioned = await h.api("POST", `/api/bots/${bot.id}/computer/provision`);
    expect(provisioned.status).toBe(200);
    expect(provisioned.body).toMatchObject({ boxId: `fake-${bot.id}`, reused: false, state: "running" });

    const after = await h.api("GET", `/api/bots/${bot.id}/computer`);
    expect(after.body.box).toMatchObject({ boxId: `fake-${bot.id}`, state: "running" });

    const exec = await h.api("POST", `/api/bots/${bot.id}/computer/exec`, { command: "echo hi" });
    expect(exec.status).toBe(200);
    expect(exec.body).toMatchObject({ exitCode: 0 });
    expect(exec.body.stdout).toContain("fake:echo hi");

    const shot = await h.api("POST", `/api/bots/${bot.id}/computer/screenshot`);
    expect(shot.status).toBe(200);
    expect(shot.body.format).toBe("png");
    expect(shot.body.png.length).toBeGreaterThan(0);

    const joined = await h.api("POST", `/api/bots/${bot.id}/computer/join`);
    expect(joined.status).toBe(200);
    expect(joined.body.joinUrl).toBe(`fake://desktop/fake-${bot.id}`);

    const slept = await h.api("POST", `/api/bots/${bot.id}/computer/sleep`);
    expect(slept.status).toBe(200);
    const parked = await h.api("GET", `/api/bots/${bot.id}/computer`);
    expect(parked.body.box.state).toBe("archived");
  });
});

describe("first run with the default config (box bundled, no token)", () => {
  let h: BootedHarness;

  beforeAll(async () => {
    h = await bootHarness({ instances });
  }, 30_000);

  afterAll(async () => {
    await h?.stop();
  });

  it("boots with computer off and no Box credential anywhere", async () => {
    const roster = await h.api("GET", "/api/bots");
    expect(roster.status).toBe(200);
    expect(roster.body.bots[0].computer).toBe("off");
    const config = await h.api("GET", "/api/config");
    expect(config.body.box).toEqual({ configured: false });
  });

  it("panel reports unconfigured without a token — never a failure", async () => {
    const bot = (await h.api("GET", "/api/bots")).body.bots[0];
    const status = await h.api("GET", `/api/bots/${bot.id}/computer`);
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({ configured: false, provider: "box", box: null });
    expect(status.body.reason).toMatch(/Box token/);
  });

  it("binding a bot to the bundled box provider needs no token; turns still run", async () => {
    const created = await h.api("POST", "/api/bots");
    const bot = created.body.bot;
    const patched = await h.api("PATCH", `/api/bots/${bot.id}`, { modelSelection: selection, computer: "cloud" });
    expect(patched.status).toBe(200);
    // the legacy "cloud" value canonicalizes to the box BINDING
    expect(patched.body.bot.computer).toBe("box");

    // an unconfigured binding must not block the turn (nothing attaches,
    // nothing prompts, no vendor is contacted)
    const sent = await h.api("POST", `/api/bots/${bot.id}/messages`, { text: "hello" });
    expect(sent.status).toBe(202);
    await h.sse.until(
      (f) => f.kind === "runtime" && f.event?.type === "turn.completed" && f.event.threadId === bot.threadId,
    );

    // provisioning without a token is an explicit, actionable error
    const provision = await h.api("POST", `/api/bots/${bot.id}/computer/provision`);
    expect(provision.status).toBe(500);
    expect(provision.body.error).toMatch(/box provider not enabled/);
  });
});
