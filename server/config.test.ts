import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { botWorkspaceDir, DATA_DIR, ensureBotWorkspace, instanceConfigs } from "./config.ts";

describe("instanceConfigs", () => {
  it("includes OpenRouter and OmniRouter on the default fleet, unavailable until keyed", () => {
    const map = instanceConfigs({});
    expect(map.openrouter).toMatchObject({ driver: "openrouter" });
    expect(map.omnirouter).toMatchObject({ driver: "omnirouter" });
    expect(map.openrouter.environment?.OPENROUTER_API_KEY).toBeUndefined();
  });

  it("puts Hermes on the default fleet but never force-adds it to a user map", () => {
    const map = instanceConfigs({});
    expect(map.hermes).toMatchObject({ driver: "hermesAgent" });
    // a user-authored non-empty instances map replaces the default fleet;
    // only openrouter/omnirouter are force-re-added
    const custom = instanceConfigs({ instances: { onlyMine: { driver: "codex" } } });
    expect(custom.hermes).toBeUndefined();
    expect(custom.onlyMine).toMatchObject({ driver: "codex" });
    expect(custom.openrouter).toMatchObject({ driver: "openrouter" });
    expect(custom.omnirouter).toMatchObject({ driver: "omnirouter" });
  });

  it("injects write-only keys into instance env and keeps a custom URL", () => {
    const map = instanceConfigs({
      openrouter: { key: "sk-or-v1-secret", url: "http://127.0.0.1:9/v1" },
      omnirouter: { key: "omni-secret" },
      instances: { ghost: { driver: "not-a-real-driver" } },
    });
    expect(map.ghost.driver).toBe("not-a-real-driver");
    expect(map.openrouter.environment?.OPENROUTER_API_KEY).toBe("sk-or-v1-secret");
    expect(map.omnirouter.environment?.OMNIROUTER_API_KEY).toBe("omni-secret");
    expect((map.openrouter.config as { url?: string }).url).toBe("http://127.0.0.1:9/v1");
  });
});

describe("per-bot workspace", () => {
  it("is under the app data dir, unique per bot, and never the home directory", () => {
    const a = ensureBotWorkspace("bot-a");
    const b = ensureBotWorkspace("bot-b");
    expect(a).toBe(botWorkspaceDir("bot-a"));
    expect(a).toBe(join(DATA_DIR, "workspaces", "bot-a"));
    expect(b).toBe(join(DATA_DIR, "workspaces", "bot-b"));
    expect(a).not.toBe(b);
    expect(a).not.toBe(homedir());
    expect(b).not.toBe(homedir());
    expect(existsSync(a)).toBe(true);
    expect(existsSync(b)).toBe(true);
  });
});
