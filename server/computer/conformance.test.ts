// The conformance suite run against every first-party provider: fake
// (pure in-memory), box (against an in-process fake vendor — no network,
// no live ascii.dev), and local (against a temp cua-connection.json).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { describeComputerProviderConformance, type ComputerConformanceContext } from "../testing/computer-conformance.ts";
import { startFakeBoxVendor } from "../testing/fake-box.ts";
import { BoxComputerProviderFactory } from "./box.ts";
import { FakeComputerProviderFactory } from "./fake.ts";
import { LocalComputerProviderFactory, readCuaConnection } from "./local.ts";

let seq = 0;
const freshBotId = () => `conformance-bot-${++seq}`;

describeComputerProviderConformance("fake", async (): Promise<ComputerConformanceContext> => {
  const provider = await FakeComputerProviderFactory.create({ id: "fake", config: {}, appConfig: {} });
  return { provider, botId: freshBotId() };
});

const BOX_SECRET = "tok_conformance_never_in_argv";

describeComputerProviderConformance("box", async (): Promise<ComputerConformanceContext> => {
  const vendor = await startFakeBoxVendor({ token: BOX_SECRET });
  const provider = await BoxComputerProviderFactory.create({
    id: "box",
    config: {},
    appConfig: { box: { token: BOX_SECRET, url: vendor.base } },
  });
  return { provider, botId: freshBotId(), secrets: [BOX_SECRET], cleanup: () => vendor.close() };
});

describeComputerProviderConformance("local", async (): Promise<ComputerConformanceContext> => {
  // the Electron main process would write this contract on startup; the
  // provider only ever reads it
  const userData = mkdtempSync(join(tmpdir(), "omb-cua-conformance-"));
  writeFileSync(
    join(userData, "cua-connection.json"),
    JSON.stringify({
      mcpCommand: "/fake/cua-driver",
      mcpArgs: ["mcp", "--embedded", "--socket", "/tmp/cua-conformance.sock"],
      mcpEnv: { CUA_DRIVER_EMBEDDED: "1" },
    }),
  );
  const priorUserData = process.env.OMB_USER_DATA;
  const priorSupported = process.env.OMB_LOCAL_CUA_SUPPORTED;
  process.env.OMB_USER_DATA = userData;
  delete process.env.OMB_LOCAL_CUA_SUPPORTED;
  const provider = await LocalComputerProviderFactory.create({ id: "local", config: {}, appConfig: {} });
  return {
    provider,
    botId: freshBotId(),
    cleanup: () => {
      if (priorUserData === undefined) delete process.env.OMB_USER_DATA;
      else process.env.OMB_USER_DATA = priorUserData;
      if (priorSupported !== undefined) process.env.OMB_LOCAL_CUA_SUPPORTED = priorSupported;
      rmSync(userData, { recursive: true, force: true });
    },
  };
});

// ── provider-specific edges the generic suite cannot cover ───────────────

describe("box provider without a token (first-run posture)", () => {
  it("reports unconfigured with a reason, mounts nothing, and never prompts", async () => {
    const provider = await BoxComputerProviderFactory.create({ id: "box", config: {}, appConfig: {} });
    const status = await provider.status("bot-x");
    expect(status).toMatchObject({ configured: false, machine: null });
    expect(status.reason).toMatch(/Box token/);
    expect(await provider.mcpIntegration("bot-x")).toBeNull();
    await expect(provider.provision({ id: "bot-x", name: "X" })).rejects.toThrow(/box provider not enabled/);
  });
});

describe("local provider without a daemon", () => {
  it("reports unconfigured with a reason and mounts nothing", async () => {
    const userData = mkdtempSync(join(tmpdir(), "omb-cua-none-"));
    const prior = process.env.OMB_USER_DATA;
    process.env.OMB_USER_DATA = userData; // empty dir — no cua-connection.json
    try {
      expect(readCuaConnection()).toBeNull();
      const provider = await LocalComputerProviderFactory.create({ id: "local", config: {}, appConfig: {} });
      const status = await provider.status("bot-x");
      expect(status).toMatchObject({ configured: false, machine: null });
      expect(status.reason).toMatch(/daemon/);
      expect(await provider.mcpIntegration("bot-x")).toBeNull();
      await expect(provider.provision({ id: "bot-x", name: "X" })).rejects.toThrow(/daemon/);
    } finally {
      if (prior === undefined) delete process.env.OMB_USER_DATA;
      else process.env.OMB_USER_DATA = prior;
      rmSync(userData, { recursive: true, force: true });
    }
  });
});

describe("box provider mcp spawn contract", () => {
  it("carries the vendor URL, machine id, and token in env — argv is vendor-blind", async () => {
    const vendor = await startFakeBoxVendor({ token: BOX_SECRET });
    try {
      const provider = await BoxComputerProviderFactory.create({
        id: "box",
        config: {},
        appConfig: { box: { token: BOX_SECRET, url: vendor.base } },
      });
      const botId = freshBotId();
      const provisioned = await provider.provision({ id: botId, name: "Spawn Bot" });
      const mcp = await provider.mcpIntegration(botId, { machineId: provisioned.machineId });
      expect(mcp).not.toBeNull();
      expect(mcp!.env.OGB_BOX_URL).toBe(vendor.base);
      expect(mcp!.env.OGB_BOX_ID).toBe(provisioned.machineId);
      expect(mcp!.env.OGB_BOX_TOKEN).toBe(BOX_SECRET);
      expect(mcp!.env.ELECTRON_RUN_AS_NODE).toBe("1");
      expect(mcp!.args.at(-1)).toMatch(/computer-proxy\.(ts|js)$/);
      expect(JSON.stringify(mcp!.args)).not.toContain(BOX_SECRET);
    } finally {
      await vendor.close();
    }
  });
});
