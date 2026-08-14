// Cloud-computer honesty: integrations.computer (and the "You have your own
// cloud computer" prompt line) may only reach drivers that can actually act
// on the bot's box — claudeAgent/codex mount the computer MCP tools and
// boxAgent runs on the box itself. Everything else must never be told it
// has a computer it cannot touch, and PATCH computer:"cloud" is rejected
// for those drivers (mirror of the local-computer 409).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type { AnyProviderDriver, ProviderInstance } from "./contracts.ts";
import { BoxAgentDriver } from "./drivers/boxagent.ts";
import { ClaudeDriver } from "./drivers/claude.ts";
import { CodexDriver } from "./drivers/codex.ts";
import { GrokAgentDriver } from "./drivers/acp/grok.ts";
import { GeminiAgentDriver } from "./drivers/acp/gemini.ts";
import { HermesAgentDriver } from "./drivers/acp/hermes.ts";

// P0.5 split the harness: turn dispatch lives in services/turns.ts, the
// bot PATCH gate in routes/bots.ts
const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const turnsSrc = readFileSync(join(SERVER_DIR, "services", "turns.ts"), "utf8");
const botsRoutesSrc = readFileSync(join(SERVER_DIR, "routes", "bots.ts"), "utf8");

async function capabilityOf(driver: AnyProviderDriver): Promise<boolean | undefined> {
  let instance: ProviderInstance | undefined;
  try {
    instance = await driver.create({
      instanceId: `${driver.driverKind}-cap-probe`,
      displayName: undefined,
      environment: {},
      enabled: true,
      // a missing binary is fine — capabilities are static per driver
      config: driver.decodeConfig({ cli: "definitely-not-a-real-binary" }),
    });
    return instance.adapter.capabilities.cloudComputer;
  } finally {
    await instance?.dispose();
  }
}

describe("cloudComputer capability matrix", () => {
  it("is true exactly for the drivers that mount or run on the box", async () => {
    expect(await capabilityOf(ClaudeDriver)).toBe(true);
    expect(await capabilityOf(CodexDriver)).toBe(true);
    expect(await capabilityOf(BoxAgentDriver)).toBe(true);
  });

  it("is unset for ACP drivers — no computer tools, no computer prompt", async () => {
    expect(await capabilityOf(HermesAgentDriver)).toBeUndefined();
    expect(await capabilityOf(GrokAgentDriver)).toBeUndefined();
    expect(await capabilityOf(GeminiAgentDriver)).toBeUndefined();
  });
});

describe("harness attach/PATCH gates (source contract)", () => {
  it("attaches integrations.computer only when the adapter has cloudComputer", () => {
    expect(turnsSrc).toMatch(
      /wants === "cloud" && box\.boxConfigured\(cfg\) && instance\.adapter\.capabilities\.cloudComputer === true/,
    );
  });

  it("keeps the cloud-computer prompt line behind integrations.computer", () => {
    expect(turnsSrc).toMatch(/integrations\.computer && instance\.driverKind !== "boxAgent"\s*\?\s*" You have your own cloud computer/);
  });

  it("mirrors the local-computer 409 for computer:\"cloud\" PATCHes", () => {
    expect(botsRoutesSrc).toContain('selectedInstance.adapter.capabilities.cloudComputer !== true');
    expect(botsRoutesSrc).toContain("selected provider has no cloud computer tools");
  });
});
