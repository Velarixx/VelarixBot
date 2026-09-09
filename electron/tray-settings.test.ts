import { describe, expect, it } from "vitest";
import {
  BACKGROUND_RUNNING_COPY,
  QUIT_ALL_LABEL,
  parseTrayEnabled,
  serializeTrayPrefs,
  trayBadgeText,
  trayMenuSpec,
  trayTooltip,
} from "./tray-settings.mjs";

describe("tray toggle", () => {
  it("defaults on when prefs are missing or empty", () => {
    expect(parseTrayEnabled(null)).toBe(true);
    expect(parseTrayEnabled(undefined)).toBe(true);
    expect(parseTrayEnabled({})).toBe(true);
    expect(parseTrayEnabled({ trayEnabled: true })).toBe(true);
  });

  it("can be turned off and round-trips through prefs JSON", () => {
    expect(parseTrayEnabled({ trayEnabled: false })).toBe(false);
    const off = serializeTrayPrefs(false);
    expect(off).not.toMatch(/secret|token|password/i);
    expect(parseTrayEnabled(JSON.parse(off))).toBe(false);
    expect(parseTrayEnabled(JSON.parse(serializeTrayPrefs(true)))).toBe(true);
  });
});

describe("tray unread badge", () => {
  it("hides at zero and caps at 99+", () => {
    expect(trayBadgeText(0)).toBe("");
    expect(trayBadgeText(-1)).toBe("");
    expect(trayBadgeText(1)).toBe("1");
    expect(trayBadgeText(12)).toBe("12");
    expect(trayBadgeText(99)).toBe("99");
    expect(trayBadgeText(100)).toBe("99+");
  });

  it("puts the count in the tooltip without leaking secrets", () => {
    expect(trayTooltip(0)).toBe("VelarixBot");
    expect(trayTooltip(3)).toBe("VelarixBot — 3 unread");
    expect(trayTooltip(120)).toBe("VelarixBot — 99+ unread");
  });

  it("tells the user the background service is still running without reading the plist", () => {
    expect(trayTooltip(0, { backgroundRunning: true })).toBe("VelarixBot — background service running");
    expect(trayTooltip(3, { backgroundRunning: true })).toBe("VelarixBot — 3 unread — background service running");
    const menu = trayMenuSpec({ backgroundRunning: true });
    expect(menu.some((row) => row.label === BACKGROUND_RUNNING_COPY && row.enabled === false)).toBe(true);
    expect(menu.some((row) => row.action === "quit-all" && row.label === QUIT_ALL_LABEL)).toBe(true);
    expect(menu.some((row) => row.action === "gui-quit" && row.label === "Quit")).toBe(true);
    expect(JSON.stringify(menu)).not.toMatch(/plist|launchctl|KeepAlive/i);
  });
});
