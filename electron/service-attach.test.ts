import { mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  CANDIDATE_PORTS,
  decideListenerAction,
  decidePackagedGuiAction,
  decideServiceHostAction,
  isAttachableOurs,
  isOursHealth,
  isSpawnedChildHealth,
  probeResultsFromMap,
  shouldForkHarness,
  waitForAttachable,
} from "./service-attach.mjs";
import { healthWithoutSecrets, readServiceAuth, writeServiceAuth } from "./service-auth.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const TOKEN = `${"ab".repeat(16)}${"cd".repeat(16)}`;

function oursHealth(pid: number) {
  return { app: "velarixbot", pid, static: true, stamp: "ensureBotWorkspace+mcpOverlay" };
}

function sidecar(pid: number, port = 8799) {
  return { app: "velarixbot" as const, pid, port, token: TOKEN };
}

describe("attach vs spawn", () => {
  it("treats ours-on-8799 with a matching sidecar as attach, never fork", () => {
    const health = oursHealth(4400);
    const side = sidecar(4400);
    expect(isOursHealth(health)).toBe(true);
    expect(isAttachableOurs(health, side)).toBe(true);
    expect(isSpawnedChildHealth(health, 4400)).toBe(true);
    expect(decideListenerAction({ health, sidecar: side })).toEqual({
      action: "attach",
      reason: "sidecar-pid",
    });
    const gui = decidePackagedGuiAction(probeResultsFromMap({ 8799: health }, side));
    expect(gui).toEqual({ action: "attach", port: 8799, reason: "sidecar-pid" });
    expect(shouldForkHarness(gui)).toBe(false);
    expect(decideServiceHostAction(probeResultsFromMap({ 8799: health }, side)).action).toBe(
      "already-running",
    );
  });

  it("does not adopt a foreign velarixbot (no sidecar / pid mismatch) and does not second-fleet", () => {
    const health = oursHealth(8800);
    expect(isAttachableOurs(health, null)).toBe(false);
    expect(decideListenerAction({ health, sidecar: null })).toEqual({
      action: "conflict",
      reason: "velarixbot-not-ours",
    });
    expect(decideListenerAction({ health, sidecar: sidecar(1) })).toEqual({
      action: "conflict",
      reason: "velarixbot-not-ours",
    });
    const gui = decidePackagedGuiAction(probeResultsFromMap({ 8799: health }, null));
    expect(gui.action).toBe("conflict");
    expect(shouldForkHarness(gui)).toBe(false);
    const host = decideServiceHostAction(probeResultsFromMap({ 8799: health }, null));
    expect(host.action).toBe("conflict");
    expect(shouldForkHarness(host)).toBe(false);
  });

  it("does not adopt a non-static velarixbot or a non-velarixbot listener", () => {
    expect(
      decideListenerAction({
        health: { app: "velarixbot", pid: 1, static: false, stamp: "x" },
        sidecar: sidecar(1),
      }).action,
    ).toBe("conflict");
    expect(
      decideListenerAction({
        health: { app: "nginx", pid: 1, static: true },
        sidecar: sidecar(1),
      }),
    ).toEqual({ action: "skip", reason: "foreign" });
  });

  it("treats an empty probe as start-service (GUI) or spawn (host)", () => {
    expect(decideListenerAction({ health: null, sidecar: null })).toEqual({
      action: "spawn",
      reason: "empty",
    });
    const empty = probeResultsFromMap({}, null);
    expect(decidePackagedGuiAction(empty)).toEqual({ action: "start-service", reason: "empty" });
    expect(shouldForkHarness(decidePackagedGuiAction(empty))).toBe(false);
    const host = decideServiceHostAction(empty);
    expect(host).toEqual({ action: "spawn", port: 8799, reason: "empty" });
    expect(shouldForkHarness(host)).toBe(true);
  });

  it("keeps pid-equals-child as spawn-only — attach still needs the sidecar", () => {
    const health = oursHealth(3200);
    expect(isSpawnedChildHealth(health, 3200)).toBe(true);
    expect(isAttachableOurs(health, null)).toBe(false);
    expect(decideListenerAction({ health, sidecar: null, childPid: 3200 })).toEqual({
      action: "spawn-owned",
      reason: "child-pid",
    });
    expect(decidePackagedGuiAction([{ port: 8799, health, sidecar: null, childPid: 3200 }]).action).toBe(
      "conflict",
    );
  });

  it("skips a foreign occupant and can start the service on a later empty port", () => {
    const rows = [
      { port: 8799, health: { app: "other", pid: 1 }, sidecar: null },
      { port: 18799, health: null, sidecar: null },
      { port: 28799, health: null, sidecar: null },
    ];
    expect(decidePackagedGuiAction(rows)).toEqual({ action: "start-service", reason: "fallback-port" });
    expect(decideServiceHostAction(rows)).toEqual({ action: "spawn", port: 18799, reason: "empty" });
  });

  it("waitForAttachable uses an injected no-op sleep and never puts the token in health", async () => {
    let sleeps = 0;
    const side = sidecar(77, 18799);
    let calls = 0;
    const found = await waitForAttachable({
      ports: CANDIDATE_PORTS,
      attempts: 3,
      sleep: async () => {
        sleeps += 1;
      },
      readSidecar: () => side,
      probe: async (port) => {
        calls += 1;
        if (calls < 4) return null;
        if (port === 18799) return oursHealth(77);
        return null;
      },
    });
    expect(found?.port).toBe(18799);
    expect(found?.sidecar?.token).toBe(TOKEN);
    expect(found && healthWithoutSecrets(found.health)).toEqual(oursHealth(77));
    expect(JSON.stringify(found?.health)).not.toContain(TOKEN);
    expect(sleeps).toBeGreaterThan(0);
    expect(sleeps).toBeLessThan(3);
  });

  it("pins the candidate ports the packaged probe still walks", () => {
    expect(CANDIDATE_PORTS).toEqual([8799, 18799, 28799]);
  });

  it("packaged GUI attaches via readServiceAuth and does not mint or write the sidecar", () => {
    const main = read("electron/main.mjs");
    expect(main).toMatch(/isService \? mintApiToken\(\) : ""/);
    expect(main).toContain("readSidecar: () => readServiceAuth()");
    expect(main).toContain("API_TOKEN = found.sidecar.token");
    const attachFn = main.slice(
      main.indexOf("async function attachToRunningService"),
      main.indexOf("function enableUserSessionService"),
    );
    expect(attachFn).toContain("readServiceAuth");
    expect(attachFn).not.toContain("writeServiceAuth");
    expect(attachFn).not.toContain("mintApiToken");
    expect(main).toMatch(/utilityProcess\.fork\(entry, \[\], \{/);
    expect(main).not.toMatch(/fork\([^)]*VELARIX_API_TOKEN/);
    expect(main).not.toMatch(/Access-Control-Allow-Origin/i);
  });

  it("second local client reads the sidecar and attaches without minting", () => {
    const home = join(tmpdir(), `velarix-second-client-${process.pid}-${Date.now()}`);
    mkdirSync(join(home, ".velarixbot"), { recursive: true, mode: 0o700 });
    const health = oursHealth(4400);
    writeServiceAuth({ pid: 4400, port: 8799, token: TOKEN }, home);
    const sidecar = readServiceAuth(home);
    expect(sidecar?.token).toBe(TOKEN);
    expect(isAttachableOurs(health, sidecar)).toBe(true);
    expect(decidePackagedGuiAction(probeResultsFromMap({ 8799: health }, sidecar))).toEqual({
      action: "attach",
      port: 8799,
      reason: "sidecar-pid",
    });
    expect(JSON.stringify(healthWithoutSecrets(health))).not.toContain(TOKEN);
  });
});
