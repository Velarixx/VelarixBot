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
  leftoverOccupantPid,
  isAttachableOurs,
  isOursHealth,
  isSpawnedChildHealth,
  planPackagedGuiBoot,
  planServiceHostBoot,
  probeResultsFromMap,
  runPackagedGuiBoot,
  runServiceHostBoot,
  shouldForkHarness,
  waitForAttachable,
} from "./service-attach.mjs";
import { healthWithoutSecrets, readServiceAuth, writeServiceAuth } from "./service-auth.mjs";
import { applyOccupantStop, isScServiceStop, planOccupantStop, windowsStopArgs } from "./service-control.mjs";

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

  it("replaces a leftover 0.2.2-shaped velarixbot (no sidecar / pid mismatch) instead of ERROR_PAGE-only", () => {
    const health = oursHealth(8800);
    expect(isAttachableOurs(health, null)).toBe(false);
    expect(leftoverOccupantPid(health, null)).toBe(8800);
    expect(leftoverOccupantPid(health, sidecar(1))).toBe(8800);
    expect(decideListenerAction({ health, sidecar: null })).toEqual({
      action: "replace",
      reason: "velarixbot-leftover",
      pid: 8800,
    });
    expect(decideListenerAction({ health, sidecar: sidecar(1) })).toEqual({
      action: "replace",
      reason: "velarixbot-leftover",
      pid: 8800,
    });
    const gui = decidePackagedGuiAction(probeResultsFromMap({ 8799: health }, null));
    expect(gui).toEqual({ action: "replace", port: 8799, reason: "velarixbot-leftover", pid: 8800 });
    expect(shouldForkHarness(gui)).toBe(false);
    const host = decideServiceHostAction(probeResultsFromMap({ 8799: health }, null));
    expect(host).toEqual({ action: "replace", port: 8799, reason: "velarixbot-leftover", pid: 8800 });
    expect(shouldForkHarness(host)).toBe(false);
    const guiPlan = planPackagedGuiBoot(gui);
    expect(guiPlan.steps).toEqual(["stop-occupant", "restart-service", "attach"]);
    expect(guiPlan.fork).toBe(false);
    expect(guiPlan.mintToken).toBe(false);
    expect(guiPlan.writeSidecar).toBe(false);
    expect(guiPlan.stopCard).toBe(true);
    expect(guiPlan.page).toBe("stop-card");
    expect(guiPlan.page).not.toBe("error-page");
    const hostPlan = planServiceHostBoot(host);
    expect(hostPlan.steps).toEqual(["stop-occupant", "spawn"]);
    expect(hostPlan.idleEmpty).toBe(false);
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
      main.indexOf("async function probeCandidatePorts"),
    );
    expect(attachFn).toContain("readServiceAuth");
    expect(attachFn).not.toContain("writeServiceAuth");
    expect(attachFn).not.toContain("mintApiToken");
    expect(attachFn).not.toContain("utilityProcess.fork");
    expect(main).toContain("STOP_PAGE");
    expect(main).toContain("leftoverStopCard");
    expect(main).toContain("stopLeftoverOccupant");
    expect(main).toContain("planOccupantStop");
    expect(main).toContain("runPackagedGuiBoot");
    expect(main).toContain("runServiceHostBoot");
    expect(main).toMatch(/utilityProcess\.fork\(entry, \[\], \{/);
    expect(main).not.toMatch(/fork\([^)]*VELARIX_API_TOKEN/);
    expect(main).not.toMatch(/Access-Control-Allow-Origin/i);
    expect(main).toContain("leftoverStopCard ? STOP_PAGE : ERROR_PAGE");
    expect(main).toMatch(/fetch\(`http:\/\/127\.0\.0\.1:\$\{port\}\/api\/health`\)/);
    const healthSrc = read("server/routes/health.ts");
    expect(healthSrc).toContain('app: "velarixbot"');
    expect(healthSrc).toContain("pid: process.pid");
    expect(healthSrc).toContain("static: deps.staticServing");
    expect(healthSrc).toContain("stamp: deps.stamp");
    expect(healthSrc).not.toMatch(/token:\s/);
    expect(read("server/index.ts")).toMatch(/server\.listen\(PORT, "127\.0\.0\.1"/);
    const prepareFn = main.slice(
      main.indexOf("async function preparePackagedGuiServer"),
      main.indexOf("function enableUserSessionService"),
    );
    expect(prepareFn).not.toContain("writeServiceAuth");
    expect(prepareFn).not.toContain("mintApiToken");
    expect(prepareFn).not.toContain("utilityProcess.fork");
  });

  it("leftover replace stops health.pid then attaches; sc stop is not the occupant stop", async () => {
    const health = oursHealth(8800);
    const gui = decidePackagedGuiAction(probeResultsFromMap({ 8799: health }, null));
    const killed: number[] = [];
    const serviceSteps: string[] = [];
    const attached = { port: 8799, health: oursHealth(9900), sidecar: sidecar(9900) };
    const result = await runPackagedGuiBoot(gui, {
      stopOccupant: (pid: number) => {
        killed.push(pid);
      },
      restartService: () => {
        serviceSteps.push("restart");
      },
      startService: () => {
        serviceSteps.push("start-only");
      },
      attach: () => attached,
    });
    expect(killed).toEqual([8800]);
    expect(serviceSteps).toEqual(["restart"]);
    expect(result.found).toEqual(attached);
    expect(result.plan.fork).toBe(false);
    expect(result.plan.mintToken).toBe(false);
    expect(result.plan.writeSidecar).toBe(false);
    expect(result.log.map((row) => row.step)).toEqual(["stop-occupant", "restart-service", "attach"]);

    const host = await runServiceHostBoot(decideServiceHostAction(probeResultsFromMap({ 8799: health }, null)), {
      stopOccupant: (pid: number) => {
        killed.push(pid);
      },
      spawn: () => true,
    });
    expect(host.spawned).toBe(true);
    expect(host.idleEmpty).toBe(false);
    expect(host.log.map((row) => row.step)).toEqual(["stop-occupant", "spawn"]);
    expect(killed).toEqual([8800, 8800]);

    const occupant = planOccupantStop({ pid: 8800, platform: "win32" });
    expect(occupant.command).toBe("taskkill");
    expect(occupant.args).toEqual(["/pid", "8800", "/T", "/F"]);
    expect(isScServiceStop(occupant)).toBe(false);
    const scStop = windowsStopArgs({ sc: "C:\\Windows\\System32\\sc.exe" });
    expect(isScServiceStop(scStop)).toBe(true);
    expect(applyOccupantStop(scStop).ok).toBe(false);
    expect(applyOccupantStop(scStop).reason).toBe("sc-stop-not-occupant");
  });

  it("matching sidecar still attaches without fork or occupant stop", async () => {
    const health = oursHealth(4400);
    const side = sidecar(4400);
    const gui = decidePackagedGuiAction(probeResultsFromMap({ 8799: health }, side));
    expect(gui).toEqual({ action: "attach", port: 8799, reason: "sidecar-pid" });
    const killed: number[] = [];
    const result = await runPackagedGuiBoot(gui, {
      stopOccupant: (pid: number) => {
        killed.push(pid);
      },
      restartService: () => {
        killed.push(-1);
      },
      attach: () => ({ port: 8799, health, sidecar: side }),
    });
    expect(killed).toEqual([]);
    expect(result.found?.port).toBe(8799);
    expect(result.plan.steps).toEqual(["attach"]);
    expect(shouldForkHarness(gui)).toBe(false);
  });

  it("does not adopt or kill a foreign non-velarixbot occupant", async () => {
    const rows = [
      { port: 8799, health: { app: "nginx", pid: 4242, static: true }, sidecar: null },
      { port: 18799, health: null, sidecar: null },
      { port: 28799, health: null, sidecar: null },
    ];
    expect(decideListenerAction(rows[0])).toEqual({ action: "skip", reason: "foreign" });
    expect(leftoverOccupantPid(rows[0].health, null)).toBeNull();
    const gui = decidePackagedGuiAction(rows);
    expect(gui).toEqual({ action: "start-service", reason: "fallback-port" });
    const killed: number[] = [];
    const result = await runPackagedGuiBoot(gui, {
      stopOccupant: (pid: number) => {
        killed.push(pid);
      },
      startService: () => undefined,
      attach: () => ({ port: 18799, sidecar: sidecar(7, 18799) }),
    });
    expect(killed).toEqual([]);
    expect(result.log.map((row) => row.step)).not.toContain("stop-occupant");
    expect(result.found?.port).toBe(18799);
    expect(decideServiceHostAction(rows)).toEqual({ action: "spawn", port: 18799, reason: "empty" });
  });

  it("replaces leftover on a later attach-scan port after an empty 8799", () => {
    const leftover = oursHealth(512);
    const rows = [
      { port: 8799, health: null, sidecar: null },
      { port: 18799, health: leftover, sidecar: null },
      { port: 28799, health: null, sidecar: null },
    ];
    expect(decidePackagedGuiAction(rows)).toEqual({
      action: "replace",
      port: 18799,
      reason: "velarixbot-leftover",
      pid: 512,
    });
    expect(decideServiceHostAction(rows)).toEqual({
      action: "replace",
      port: 18799,
      reason: "velarixbot-leftover",
      pid: 512,
    });
  });

  it("matching sidecar on a later port still attaches even if 8799 is leftover", () => {
    const leftover = oursHealth(1);
    const ours = oursHealth(77);
    const side = sidecar(77, 18799);
    const rows = [
      { port: 8799, health: leftover, sidecar: side },
      { port: 18799, health: ours, sidecar: side },
      { port: 28799, health: null, sidecar: side },
    ];
    expect(decidePackagedGuiAction(rows)).toEqual({ action: "attach", port: 18799, reason: "sidecar-pid" });
    expect(shouldForkHarness(decidePackagedGuiAction(rows))).toBe(false);
    expect(decideServiceHostAction(rows).action).toBe("already-running");
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
