import { describe, expect, it } from "vitest";

import { shouldQuitOnLastWindow } from "./background.mjs";
import { guiQuitAction, serviceProcessQuitAction, shouldKillServerOnBeforeQuit, trayShowAction } from "./service-quit.mjs";

describe("quit does not kill the OS-owned harness", () => {
  it("tray/GUI quit leaves an attached or service-owned harness up", () => {
    expect(guiQuitAction({ ownership: "service" })).toEqual({
      killServer: false,
      quitApp: true,
      hideWindow: true,
      stopOsService: false,
    });
    expect(guiQuitAction({ ownership: "attached" })).toEqual({
      killServer: false,
      quitApp: true,
      hideWindow: true,
      stopOsService: false,
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
