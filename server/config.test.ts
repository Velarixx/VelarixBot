import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  botWorkspaceDir,
  DATA_DIR,
  ensureBotWorkspace,
  ensureDirs,
  instanceConfigs,
  loadConfig,
  migrateConfigSecrets,
  saveConfig,
} from "./config.ts";

/** Clearly-fake runtime-constructed canaries — never credential-shaped literals. */
function canary(tag: string): string {
  return ["fake", tag, "canary", Date.now().toString(36), Math.random().toString(36).slice(2)].join("-");
}

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
    // an unrelated driver's subprocess env gets NO key at all
    expect(map.ghost.environment?.OPENROUTER_API_KEY).toBeUndefined();
    expect(map.ghost.environment?.OMNIROUTER_API_KEY).toBeUndefined();
  });

  it("scopes each secret to the driver that needs it — never the whole ring", () => {
    const cfg = {
      xai: { key: "xai-fake-key" },
      box: { token: "box-fake-token" },
      openrouter: { key: "or-fake-key" },
      omnirouter: { key: "omni-fake-key" },
    };
    const map = instanceConfigs(cfg);
    // boxAgent gets the Box token and nothing else
    expect(map.computer.environment).toEqual({ BOX_TOKEN: "box-fake-token" });
    // routers get exactly their own key
    expect(map.openrouter.environment).toEqual({ OPENROUTER_API_KEY: "or-fake-key" });
    expect(map.omnirouter.environment).toEqual({ OMNIROUTER_API_KEY: "omni-fake-key" });
    // CLI-login drivers take no key from us
    expect(map.claude.environment).toEqual({});
    expect(map.codex.environment).toEqual({});
    expect(map.grok.environment).toEqual({}); // default grok = grokAgent (CLI login)

    // the API-key grok driver, when a user adds it, gets the xAI key
    const custom = instanceConfigs({ ...cfg, instances: { grokApi: { driver: "grok" } } });
    expect(custom.grokApi.environment).toEqual({ XAI_API_KEY: "xai-fake-key" });

    // a user-authored environment always wins and passes through untouched
    const authored = instanceConfigs({
      ...cfg,
      instances: { mine: { driver: "boxAgent", environment: { BOX_TOKEN: "user-owned", EXTRA: "1" } } },
    });
    expect(authored.mine.environment).toEqual({ BOX_TOKEN: "user-owned", EXTRA: "1" });
  });
});

describe("config persistence hardening", () => {
  const posixOnly = process.platform === "win32" ? it.skip : it;

  it("saves atomically (no temp litter); config.json holds secret refs, not values", async () => {
    ensureDirs();
    const boxToken = canary("box");
    const githubToken = canary("github");
    await saveConfig({ box: { token: boxToken, url: "https://box.example" } });
    await saveConfig({ github: { token: githubToken } });
    const raw = readFileSync(join(DATA_DIR, "config.json"), "utf8");
    expect(raw).not.toContain(boxToken);
    expect(raw).not.toContain(githubToken);
    const disk = JSON.parse(raw);
    expect(disk.box.token).toBe("secret://box.token");
    expect(disk.github.token).toBe("secret://github.token");
    // non-secret fields stay readable plaintext
    expect(disk.box.url).toBe("https://box.example");
    // in-memory config resolves the refs back to the values
    const cfg = loadConfig();
    expect(cfg.box?.token).toBe(boxToken);
    expect(cfg.github?.token).toBe(githubToken);
    expect(readdirSync(DATA_DIR).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("clearing a key deletes the ref from config.json and the stored secret", async () => {
    ensureDirs();
    const key = canary("omni");
    await saveConfig({ omnirouter: { key } });
    expect(loadConfig().omnirouter?.key).toBe(key);

    await saveConfig({ omnirouter: { key: "" } });
    const disk = JSON.parse(readFileSync(join(DATA_DIR, "config.json"), "utf8"));
    expect(disk.omnirouter.key).toBeUndefined();
    expect(loadConfig().omnirouter?.key).toBeUndefined();
    const secrets = JSON.parse(readFileSync(join(DATA_DIR, "secrets.json"), "utf8"));
    expect(secrets.entries["omnirouter.key"]).toBeUndefined();
  });

  it("migrates a pre-P1.5 plaintext config.json into the secret store", async () => {
    ensureDirs();
    const xaiKey = canary("xai");
    const composioKey = canary("composio");
    // simulate an old on-disk config with plaintext secrets
    writeFileSync(
      join(DATA_DIR, "config.json"),
      JSON.stringify({
        xai: { key: xaiKey },
        composio: { key: composioKey, url: "https://composio.example" },
        instances: { mine: { driver: "codex" } },
      }),
    );

    expect(await migrateConfigSecrets()).toBe(true);
    const raw = readFileSync(join(DATA_DIR, "config.json"), "utf8");
    expect(raw).not.toContain(xaiKey);
    expect(raw).not.toContain(composioKey);
    const disk = JSON.parse(raw);
    expect(disk.xai.key).toBe("secret://xai.key");
    expect(disk.composio.key).toBe("secret://composio.key");
    // non-secrets and unrelated sections survive untouched
    expect(disk.composio.url).toBe("https://composio.example");
    expect(disk.instances.mine.driver).toBe("codex");
    // values still resolve for the runtime
    const cfg = loadConfig();
    expect(cfg.xai?.key).toBe(xaiKey);
    expect(cfg.composio?.key).toBe(composioKey);
    // second run is a no-op — the file is not rewritten
    expect(await migrateConfigSecrets()).toBe(false);
  });

  posixOnly("keeps the data dir 0700, config.json and secrets.json 0600", async () => {
    ensureDirs();
    await saveConfig({ box: { token: canary("mode") } });
    expect(statSync(DATA_DIR).mode & 0o777).toBe(0o700);
    expect(statSync(join(DATA_DIR, "config.json")).mode & 0o777).toBe(0o600);
    expect(statSync(join(DATA_DIR, "secrets.json")).mode & 0o777).toBe(0o600);
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
