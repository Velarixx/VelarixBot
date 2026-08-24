import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  FEATURE_PERMISSIONS,
  FORBIDDEN_ENTITLEMENTS,
  FORBIDDEN_USAGE_KEYS,
  LAUNCH_FORBIDDEN_REQUESTS,
  USAGE_DESCRIPTIONS,
  appleMusicAllowed,
  permissionForFeature,
  shouldRequestAtLaunch,
} from "./macos-permissions.mjs";
import { deferredCuaConnection } from "./cua-connection.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

describe("macOS permission policy", () => {
  it("does not request any TCC class at launch, and never Apple Music except a music action", () => {
    for (const perm of LAUNCH_FORBIDDEN_REQUESTS) {
      expect(shouldRequestAtLaunch(perm)).toBe(false);
    }
    expect(permissionForFeature("dictation")).toEqual(["microphone", "speech"]);
    expect(permissionForFeature("localComputerPreview")).toEqual(["screen"]);
    expect(permissionForFeature("localComputerControl")).toEqual(["accessibility", "screen"]);
    expect(appleMusicAllowed("dictation")).toBe(false);
    expect(appleMusicAllowed("localComputerControl")).toBe(false);
    expect(appleMusicAllowed("appleMusic")).toBe(true);
    expect(FEATURE_PERMISSIONS.appleMusic).toEqual(["apple-music"]);
  });

  it("ships usage strings that name the feature and omits Apple Music / Media Library keys", () => {
    const builder = read("electron-builder.yml");
    const entitlements = read("build/entitlements.mac.plist");
    for (const [key, text] of Object.entries(USAGE_DESCRIPTIONS)) {
      expect(builder).toContain(`${key}: ${text}`);
    }
    for (const key of FORBIDDEN_USAGE_KEYS) {
      expect(builder).not.toContain(key);
      expect(entitlements).not.toContain(key);
    }
    for (const key of FORBIDDEN_ENTITLEMENTS) {
      expect(entitlements).not.toContain(key);
    }
    expect(USAGE_DESCRIPTIONS.NSMicrophoneUsageDescription).toMatch(/dictation/i);
    expect(USAGE_DESCRIPTIONS.NSAccessibilityUsageDescription).toMatch(/control this Mac/i);
    expect(USAGE_DESCRIPTIONS.NSScreenCaptureUsageDescription).toMatch(/This Mac/i);
  });

  it("defers cua-driver until the local-computer feature path", () => {
    const main = read("electron/main.mjs");
    const cua = read("electron/cua.mjs");
    const preload = read("electron/preload.cjs");
    const panel = read("src/components/ComputerPanel.tsx");
    const store = read("src/state/store.tsx");
    expect(main).toContain("prepareDeferredCua");
    expect(main).not.toMatch(/startCua\(\)\s*\.catch/);
    expect(cua).toContain("ensureCua");
    expect(cua).toContain("deferredCuaConnection");
    expect(preload).toContain("cua:ensure");
    expect(panel).toContain("ensureCua");
    expect(store).toContain('bot?.computer === "local"');
    expect(store).toContain("ensureCua");
    expect(deferredCuaConnection().mode).toBe("deferred");
    expect(deferredCuaConnection().mcpCommand).toBeUndefined();
  });

  it("keeps microphone and speech on the dictation path and never asks from launch", () => {
    const main = read("electron/main.mjs");
    const composer = read("src/components/Composer.tsx");
    const onboarding = read("src/components/Onboarding.tsx");
    const requestMic = main.indexOf('ipcMain.handle("perm:request-mic"');
    const ask = main.indexOf('askForMediaAccess("microphone")');
    const ready = main.indexOf("app.whenReady()");
    expect(requestMic).toBeGreaterThan(0);
    expect(ask).toBeGreaterThan(requestMic);
    expect(ask).toBeLessThan(ready);
    expect(main).not.toMatch(/askForMediaAccess\(\s*["'](?!microphone)/);
    expect(composer).toContain("void bridge.speechStart()");
    expect(composer).toContain("if (!recording) return");
    expect(onboarding).toContain("permRequestMic");
    expect(onboarding).toContain("Only requested for dictation");
    expect(onboarding).toMatch(/onClick=\{\(\) => window\.ogb\?\.permRequestMic/);
    expect(onboarding).not.toMatch(/useEffect\([\s\S]*permRequestMic/);
  });
});
