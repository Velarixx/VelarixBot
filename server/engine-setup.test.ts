import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  SETUP_ENGINE_OPTIONS,
  SWITCH_MODEL_OPTION,
  cliMissing,
  engineSetupCard,
  isMachineStateCode,
  isSpawnFailure,
  normalizeBotColor,
  normalizeBotName,
  setCliSearchPathForTests,
  userFacingBlock,
} from "./engine-setup.ts";

afterEach(() => {
  setCliSearchPathForTests(undefined);
});

describe("cliMissing", () => {
  it("is true for an absolute path that is not on disk", () => {
    expect(cliMissing("/definitely-not-a-velarix-engine")).toBe(true);
    expect(cliMissing(undefined)).toBe(false);
    expect(cliMissing(process.execPath)).toBe(false);
  });

  it("treats a bare PATH name as missing when it is not on the search path", () => {
    expect(cliMissing("claude", "")).toBe(true);
    expect(cliMissing("codex", "")).toBe(true);
    expect(cliMissing("grok", "")).toBe(true);
    expect(cliMissing("gemini", "")).toBe(true);
    setCliSearchPathForTests("");
    expect(cliMissing("claude")).toBe(true);
  });

  it("finds a bare name when a dummy binary is on the search path", () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-cli-path-"));
    const bin = join(dir, "claude");
    writeFileSync(bin, "#!/bin/sh\n");
    try {
      chmodSync(bin, 0o755);
    } catch {
      /* Windows */
    }
    expect(cliMissing("claude", dir)).toBe(false);
    expect(cliMissing("codex", dir)).toBe(true);
  });
});

describe("normalizeBotName", () => {
  it("trims a usable name and rejects whitespace-only", () => {
    expect(normalizeBotName("  Scout  ")).toEqual({ ok: true, name: "Scout" });
    expect(normalizeBotName("   ")).toEqual({ ok: false, error: "name cannot be empty" });
    expect(normalizeBotName("")).toEqual({ ok: false, error: "name cannot be empty" });
    expect(normalizeBotName(123)).toEqual({ ok: false, error: "name must be a string" });
  });
});

describe("normalizeBotColor", () => {
  it("accepts the palette and rejects anything else", () => {
    expect(normalizeBotColor("blue")).toBe("blue");
    expect(normalizeBotColor("not-a-color")).toBeNull();
    expect(normalizeBotColor(1)).toBeNull();
  });
});

describe("userFacingBlock", () => {
  it("never copies spawn_error into stateDetail; keeps the code on stateCode", () => {
    const blocked = userFacingBlock({
      stopReason: "spawn_error",
      snapshotReason: "`claude` CLI not found",
    });
    expect(blocked.stateCode).toBe("spawn_error");
    expect(blocked.stateDetail).toBe("`claude` CLI not found");
    expect(blocked.stateDetail).not.toMatch(/spawn_error/i);
  });

  it("humanizes a spawn-failed runtime message when snapshot reason is missing", () => {
    const blocked = userFacingBlock({
      stopReason: "spawn_error",
      runtimeMessage: "spawn failed: spawn ENOENT",
    });
    expect(blocked.stateCode).toBe("spawn_error");
    expect(blocked.stateDetail).toContain("ENOENT");
    expect(blocked.stateDetail).not.toBe("spawn_error");
    expect(blocked.stateDetail).not.toMatch(/The selected engine CLI is not available/);
  });

  it("prefers a prior human snapshot reason over the generic spawn_error fallback", () => {
    const blocked = userFacingBlock({
      stopReason: "spawn_error",
      snapshotReason: "`claude` CLI not found",
      runtimeMessage: "spawn failed: spawn ENOENT claude",
    });
    expect(blocked.stateDetail).toBe("`claude` CLI not found");
  });

  it("zero engines is a dedicated non-hanging copy", () => {
    const blocked = userFacingBlock({ zeroEngines: true });
    expect(blocked.stateCode).toBe("no_engines");
    expect(blocked.stateDetail).toMatch(/Claude, Codex, Grok, or Gemini/);
    expect(blocked.stateDetail).not.toMatch(/spawn_error/i);
  });

  it("treats snake_case stopReasons as machine codes", () => {
    expect(isMachineStateCode("spawn_error")).toBe(true);
    expect(isMachineStateCode("auth_required")).toBe(true);
    expect(isMachineStateCode("The CLI exploded")).toBe(false);
    expect(isSpawnFailure("spawn_error")).toBe(true);
    expect(isSpawnFailure(undefined, "spawn failed: x")).toBe(true);
  });
});

describe("engineSetupCard", () => {
  it("covers Claude/Codex/Grok/Gemini install+sign-in and can lead with switch-model", () => {
    const zero = engineSetupCard({ reason: "none available", zeroEngines: true });
    expect(zero.requestType).toBe("setup");
    expect(zero.title).toBe("Set up a local engine");
    expect(zero.options).toEqual([...SETUP_ENGINE_OPTIONS]);
    expect(zero.options.join("\n")).toMatch(/claude/i);
    expect(zero.options.join("\n")).toMatch(/codex/i);
    expect(zero.options.join("\n")).toMatch(/grok/i);
    expect(zero.options.join("\n")).toMatch(/gemini/i);

    const one = engineSetupCard({ reason: "`claude` CLI not found", offerSwitch: true });
    expect(one.options[0]).toBe(SWITCH_MODEL_OPTION);
    expect(one.options.slice(1)).toEqual([...SETUP_ENGINE_OPTIONS]);
  });
});
