import { describe, expect, it } from "vitest";
import { shouldQuitOnLastWindow } from "./background.mjs";

describe("shouldQuitOnLastWindow", () => {
  it("keeps the harness alive on every platform when the tray is enabled", () => {
    expect(shouldQuitOnLastWindow({ platform: "win32", trayEnabled: true })).toBe(false);
    expect(shouldQuitOnLastWindow({ platform: "linux", trayEnabled: true })).toBe(false);
    expect(shouldQuitOnLastWindow({ platform: "darwin", trayEnabled: true })).toBe(false);
  });

  it("quits Windows/Linux when there is no tray, and stays in the macOS Dock", () => {
    expect(shouldQuitOnLastWindow({ platform: "win32", trayEnabled: false })).toBe(true);
    expect(shouldQuitOnLastWindow({ platform: "linux", trayEnabled: false })).toBe(true);
    expect(shouldQuitOnLastWindow({ platform: "darwin", trayEnabled: false })).toBe(false);
  });
});
