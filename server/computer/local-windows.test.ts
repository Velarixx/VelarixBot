// P2.4: Windows local computer is the same CUA MCP contract as darwin.
// Isolated HOME (vitest setup). No live CUA, no sleeps, no desktop clicks.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FAKE_CLAUDE_CLI, FAKE_ACP_CLI, bootHarness, type BootedHarness } from "../testing/harness.ts";
import { LocalComputerProviderFactory } from "./local.ts";

const instances = {
  claude: {
    driver: "claudeAgent",
    config: { cli: FAKE_CLAUDE_CLI, permissionMode: "bypassPermissions" },
  },
  hermes: {
    driver: "hermesAgent",
    config: { cli: FAKE_ACP_CLI },
  },
};
const selection = { instanceId: "claude", model: "claude-fake" };

describe("OMB_LOCAL_CUA_SUPPORTED gate", () => {
  it("=1 no longer 409s Windows — PATCH local succeeds for Claude", async () => {
    const h = await bootHarness({ instances, env: { OMB_LOCAL_CUA_SUPPORTED: "1" } });
    try {
      const created = await h.api("POST", "/api/bots");
      const patched = await h.api("PATCH", `/api/bots/${created.body.bot.id}`, {
        modelSelection: selection,
        computer: "local",
      });
      expect(patched.status).toBe(200);
      expect(patched.body.bot.computer).toBe("local");
      expect(JSON.stringify(patched.body)).not.toMatch(/Windows/);
    } finally {
      await h.stop();
    }
  });

  it("=0 still 409s local (unsupported platform kill-switch)", async () => {
    const h = await bootHarness({ instances, env: { OMB_LOCAL_CUA_SUPPORTED: "0" } });
    try {
      const created = await h.api("POST", "/api/bots");
      await h.api("PATCH", `/api/bots/${created.body.bot.id}`, { modelSelection: selection });
      const denied = await h.api("PATCH", `/api/bots/${created.body.bot.id}`, { computer: "local" });
      expect(denied.status).toBe(409);
      expect(denied.body.error).toMatch(/not available/);
    } finally {
      await h.stop();
    }
  });

  it("keeps local×Always-allow, local×fullAuto, and missing-localComputerMcp 409s when supported", async () => {
    const h = await bootHarness({
      instances: {
        ...instances,
        claude: {
          driver: "claudeAgent",
          config: { cli: FAKE_CLAUDE_CLI, permissionMode: "bypassPermissions", fullAuto: true },
        },
      },
      env: { OMB_LOCAL_CUA_SUPPORTED: "1" },
    });
    try {
      const created = await h.api("POST", "/api/bots");
      const bot = created.body.bot;
      await h.api("PATCH", `/api/bots/${bot.id}`, { modelSelection: selection });

      const always = await h.api("PATCH", `/api/bots/${bot.id}`, { computer: "local", alwaysAllow: true });
      expect(always.status).toBe(409);
      expect(always.body.error).toMatch(/Always allow/);

      const fullAuto = await h.api("PATCH", `/api/bots/${bot.id}`, {
        computer: "local",
        modelSelection: { instanceId: "claude", model: "claude-fake" },
      });
      expect(fullAuto.status).toBe(409);
      expect(fullAuto.body.error).toMatch(/full-auto/);

      const hermes = await h.api("PATCH", `/api/bots/${bot.id}`, {
        computer: "off",
        alwaysAllow: false,
        modelSelection: { instanceId: "hermes", model: "hermes-fake" },
      });
      expect(hermes.status).toBe(200);
      const acpLocal = await h.api("PATCH", `/api/bots/${bot.id}`, { computer: "local" });
      expect(acpLocal.status).toBe(409);
      expect(acpLocal.body.error).toMatch(/does not support guarded local computer/);
    } finally {
      await h.stop();
    }
  });
});

describe("per-bot computer isolation", () => {
  let h: BootedHarness;
  beforeAll(async () => {
    h = await bootHarness({ instances, env: { OMB_LOCAL_CUA_SUPPORTED: "1" } });
  }, 30_000);
  afterAll(async () => {
    await h?.stop();
  });

  it("one bot on local does not force another bot's computer", async () => {
    const a = (await h.api("POST", "/api/bots")).body.bot;
    const b = (await h.api("POST", "/api/bots")).body.bot;
    expect((await h.api("PATCH", `/api/bots/${a.id}`, { modelSelection: selection, computer: "local" })).status).toBe(200);
    expect((await h.api("PATCH", `/api/bots/${b.id}`, { modelSelection: selection, computer: "off" })).status).toBe(200);
    const roster = await h.api("GET", "/api/bots");
    const left = roster.body.bots.find((bot: { id: string }) => bot.id === a.id);
    const right = roster.body.bots.find((bot: { id: string }) => bot.id === b.id);
    expect(left.computer).toBe("local");
    expect(right.computer).toBe("off");
  });
});

describe("local provider with OMB_LOCAL_CUA_SUPPORTED=1", () => {
  it("does not report Windows-unavailable, and still rejects screenshot/execute", async () => {
    const userData = mkdtempSync(join(tmpdir(), "omb-cua-win-"));
    writeFileSync(
      join(userData, "cua-connection.json"),
      JSON.stringify({
        mode: "standalone",
        mcpCommand: "C:\\\\fake\\\\cua-driver.exe",
        mcpArgs: ["mcp"],
        mcpEnv: {},
      }),
    );
    const priorUserData = process.env.OMB_USER_DATA;
    const priorSupported = process.env.OMB_LOCAL_CUA_SUPPORTED;
    process.env.OMB_USER_DATA = userData;
    process.env.OMB_LOCAL_CUA_SUPPORTED = "1";
    try {
      const provider = await LocalComputerProviderFactory.create({ id: "local", config: {}, appConfig: {} });
      const status = await provider.status("bot-win");
      expect(status.configured).toBe(true);
      expect(status.reason ?? "").not.toMatch(/Windows/);
      expect(provider.capabilities.screenshot).toBe(false);
      await expect(provider.screenshot("bot-win")).rejects.toThrow(/does not support/);
      await expect(collect(provider.execute("bot-win", "echo hi"))).rejects.toThrow(/does not support/);
      await expect(provider.readFile("bot-win", "C:\\\\tmp\\\\x.txt")).rejects.toThrow(/does not support/);
    } finally {
      if (priorUserData === undefined) delete process.env.OMB_USER_DATA;
      else process.env.OMB_USER_DATA = priorUserData;
      if (priorSupported === undefined) delete process.env.OMB_LOCAL_CUA_SUPPORTED;
      else process.env.OMB_LOCAL_CUA_SUPPORTED = priorSupported;
      rmSync(userData, { recursive: true, force: true });
    }
  });
});

async function collect(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const ev of stream) events.push(ev);
  return events;
}
