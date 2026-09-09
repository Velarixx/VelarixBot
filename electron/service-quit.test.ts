import { describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { shouldQuitOnLastWindow } from "./background.mjs";
import { applyServicePlan, planServiceStop } from "./service-control.mjs";
import {
  applyQuitAllPlan,
  guiQuitAction,
  quitAllAction,
  serviceProcessQuitAction,
  shouldKillServerOnBeforeQuit,
  trayShowAction,
} from "./service-quit.mjs";

describe("quit does not kill the OS-owned harness", () => {
  it("tray/GUI quit leaves an attached or service-owned harness up", () => {
    expect(guiQuitAction({ ownership: "service" })).toEqual({
      killServer: false,
      quitApp: true,
      hideWindow: true,
      stopOsService: false,
      writeSuppress: false,
    });
    expect(guiQuitAction({ ownership: "attached" })).toEqual({
      killServer: false,
      quitApp: true,
      hideWindow: true,
      stopOsService: false,
      writeSuppress: false,
    });
    expect(shouldKillServerOnBeforeQuit({ role: "gui", ownership: "attached" })).toBe(false);
    expect(shouldKillServerOnBeforeQuit({ role: "gui", ownership: "service" })).toBe(false);
  });

  it("a spawn-owned child (unpackaged fallback) may still be killed; the OS service stop always kills", () => {
    expect(guiQuitAction({ ownership: "spawned" }).killServer).toBe(true);
    expect(shouldKillServerOnBeforeQuit({ role: "gui", ownership: "spawned" })).toBe(true);
    expect(serviceProcessQuitAction()).toEqual({
      killServer: true,
      quitApp: true,
      removeSidecar: true,
      stopOsService: false,
      writeSuppress: false,
    });
    expect(shouldKillServerOnBeforeQuit({ role: "service" })).toBe(true);
  });

  it("tray Show only shows/attaches the window", () => {
    expect(trayShowAction()).toEqual({
      killServer: false,
      quitApp: false,
      showWindow: true,
      forkHarness: false,
    });
  });

  it("does not regress shouldQuitOnLastWindow / close-to-hide", () => {
    expect(shouldQuitOnLastWindow({ platform: "win32", trayEnabled: true })).toBe(false);
    expect(shouldQuitOnLastWindow({ platform: "darwin", trayEnabled: true })).toBe(false);
    expect(shouldQuitOnLastWindow({ platform: "win32", trayEnabled: false })).toBe(true);
    expect(shouldQuitOnLastWindow({ platform: "darwin", trayEnabled: false })).toBe(false);
  });
});

describe("Quit All / Stop Background Service", () => {
  it("is distinct from closing the window and bootouts the LaunchAgent without kickstart", () => {
    const close = guiQuitAction({ ownership: "attached" });
    expect(close.stopOsService).toBe(false);
    expect(close.writeSuppress).toBe(false);

    const action = quitAllAction({ platform: "darwin", uid: 501 });
    expect(action.stopOsService).toBe(true);
    expect(action.writeSuppress).toBe(true);
    expect(action.kickstart).toBe(false);
    expect(action.stop.command).toBe("/bin/launchctl");
    expect(action.stop.args).toEqual(["bootout", "gui/501/com.velarix.bot.harness"]);
    expect(action.stop.args).not.toContain("kickstart");
    expect(action.stop.reason).toBe("bootout");
    expect(action.stop.pid).toBeUndefined();

    const calls = [];
    const written = [];
    applyQuitAllPlan(action, {
      writeSuppress: () => written.push("marker"),
      applyStop: (plan) => {
        calls.push([plan.command, plan.args]);
        return applyServicePlan(plan, {
          spawnSyncFn: (command, args) => {
            calls.push(["spawn", command, args]);
            return { status: 0 };
          },
        });
      },
    });
    expect(written).toEqual(["marker"]);
    expect(calls[0]).toEqual(["/bin/launchctl", ["bootout", "gui/501/com.velarix.bot.harness"]]);
    expect(calls[1]).toEqual(["spawn", "/bin/launchctl", ["bootout", "gui/501/com.velarix.bot.harness"]]);
    expect(JSON.stringify(calls)).not.toMatch(/kickstart/);
  });

  it("keeps the Windows userown stop contract on Quit All", () => {
    const action = quitAllAction({
      platform: "win32",
      env: { SystemRoot: "C:\\Windows" },
    });
    expect(action.stop.args).toEqual(["stop", "velarixbot-harness"]);
    expect(planServiceStop({ running: true, platform: "win32", env: { SystemRoot: "C:\\Windows" } }).args).toEqual(
      action.stop.args,
    );
    expect(quitAllAction({ platform: "linux" }).stop.action).toBe("unsupported");
  });

  it("wires close-leaves-service and Quit All into main without live launchctl", () => {
    const main = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "main.mjs"), "utf8");
    expect(main).toContain("harnessServiceStartDecision");
    expect(main).toContain("exit-suppressed");
    expect(main).toContain("applyQuitAll");
    expect(main).toContain("guiOpenDecision");
    expect(main).toContain("clearHarnessBootSuppress");
    expect(main).toMatch(/isQuitting = true;\s*app\.quit\(\)/);
    expect(main).not.toMatch(/shell:\s*true/);
    expect(main).toContain("quitAllAction");
  });
});
