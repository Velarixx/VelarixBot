import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  HARNESS_BOOT_SUPPRESS_FILE,
  clearHarnessBootSuppress,
  guiOpenDecision,
  harnessBootSuppressPath,
  harnessServiceStartDecision,
  isHarnessBootSuppressed,
  startBackgroundDecision,
  writeHarnessBootSuppress,
} from "./harness-boot-suppress.mjs";

function tempHome() {
  const home = mkdtempSync(join(tmpdir(), "velarix-suppress-"));
  mkdirSync(join(home, ".velarixbot"), { recursive: true, mode: 0o700 });
  return home;
}

describe("harness boot suppress marker", () => {
  it("writes a non-secret flag under ~/.velarixbot and never puts a token in it", () => {
    const home = tempHome();
    const dest = writeHarnessBootSuppress({ home });
    expect(dest).toBe(join(home, ".velarixbot", HARNESS_BOOT_SUPPRESS_FILE));
    expect(harnessBootSuppressPath(home)).toBe(dest);
    expect(isHarnessBootSuppressed({ home })).toBe(true);
    const body = readFileSync(dest, "utf8");
    expect(body).toMatch(/quit-all/);
    expect(body).not.toMatch(/[0-9a-f]{64}/);
    expect(body).not.toMatch(/VELARIX_API_TOKEN|secret:\/\//i);
  });

  it("clears only via explicit clear — presence alone is enough to suppress", () => {
    const home = tempHome();
    writeFileSync(harnessBootSuppressPath(home), "1\n");
    expect(isHarnessBootSuppressed({ home })).toBe(true);
    clearHarnessBootSuppress({ home });
    expect(isHarnessBootSuppressed({ home })).toBe(false);
    expect(() => clearHarnessBootSuppress({ home })).not.toThrow();
  });

  it("a respawned harness with the marker exits 0 without serving and does not clear on RunAtLoad", () => {
    expect(harnessServiceStartDecision({ suppressPresent: true })).toEqual({
      action: "exit-suppressed",
      exitCode: 0,
      serve: false,
      clearSuppress: false,
    });
    expect(harnessServiceStartDecision({ suppressPresent: false })).toEqual({
      action: "boot",
      serve: true,
      clearSuppress: false,
    });
  });

  it("clears the marker when the user opens the app or chooses start-background after a stop", () => {
    expect(guiOpenDecision()).toEqual({ clearSuppress: true });
    expect(startBackgroundDecision()).toEqual({ clearSuppress: true });
    expect(harnessServiceStartDecision({ suppressPresent: true }).clearSuppress).toBe(false);
  });
});
