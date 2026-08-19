// ACP driver contract tests, run against the scripted fake ACP CLI in
// server/testing/fake-acp-cli.ts. Covers the shared acp/core.ts runtime via
// its two harness shims (grok = fail-closed auth, gemini = lenient auth):
// normalize the ACP handshake into canonical events, keep argv/env hygiene,
// broker permission asks, and settle interrupts/crashes cleanly.
//
// All applicable lifecycle/snapshot cases run cross-platform. A `.ts` CLI
// path is resolved to process.execPath by the shared launch helper, so the
// shebang is never the process contract. Remaining Windows N/A skips: none.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureDirs, DATA_DIR } from "../../config.ts";
import type { ProviderInstance } from "../../contracts.ts";
import { cliExec } from "../cli.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
import { applyAcpCredentialAllowlist, createAcpDriver, DEFAULT_ACP_CREDENTIAL_ENV, type AcpSupport } from "./core.ts";
import { GEMINI_CREDENTIAL_ENV, GeminiAgentDriver } from "./gemini.ts";
import { GrokAgentDriver } from "./grok.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "testing", "fake-acp-cli.ts");
// Keep spawned fakes out of the suite's throwaway HOME. Windows taskkill is
// asynchronous, so using HOME as their cwd can race setup.ts deleting it
// after every assertion has already passed.
const FAKE_CWD = process.cwd();

/** A harness that exists only in tests: no transformEnv, no credentialEnv.
 *  Proves the core deny-by-default allowlist — a forgotten hook must not
 *  inherit the provider key ring. generateText rides the same childEnv. */
const BARE_SUPPORT: AcpSupport = {
  driverKind: "bareAgent",
  displayName: "Bare ACP",
  models: { default: "bare", options: [{ id: "bare", label: "Bare" }] },
  defaultCli: "bare-acp",
  nativeSource: "bare.acp",
  loginNote: "never reached",
  spawnArgs: () => ["acp"],
  pickAuthMethod: () => null,
  authFailure: "continue",
  isAuthenticated: () => true,
  generateText: async (config, env, prompt) => {
    const result = await cliExec(config.cli, ["exec", "-p", prompt], {
      timeout: 8_000,
      env: env as NodeJS.ProcessEnv,
    });
    if (!result.ok) throw new Error(result.stderr.trim() || "exec failed");
    return result.stdout.trim();
  },
};
const BareAcpDriver = createAcpDriver(BARE_SUPPORT);

const PLANTED = {
  SECRET_KEY: "planted-secret-canary",
  ANTHROPIC_API_KEY: "planted-anthropic-canary",
  OPENAI_API_KEY: "planted-openai-canary",
  XAI_API_KEY: "planted-xai-canary",
  GEMINI_API_KEY: "planted-gemini-canary",
  OPENROUTER_API_KEY: "planted-openrouter-canary",
  OMNIROUTER_API_KEY: "planted-omnirouter-canary",
} as const;

function plantProviderKeys() {
  for (const [key, value] of Object.entries(PLANTED)) process.env[key] = value;
}

function unplantProviderKeys() {
  for (const key of Object.keys(PLANTED)) delete process.env[key];
}

describe("ACP decodeConfig", () => {
  it("grok defaults to the grok binary", () => {
    expect(GrokAgentDriver.decodeConfig({})).toEqual({ cli: "grok", fullAuto: false, workspace: undefined });
  });
  it("gemini defaults to the gemini binary", () => {
    expect(GeminiAgentDriver.decodeConfig(undefined)).toEqual({ cli: "gemini", fullAuto: false, workspace: undefined });
  });
  it("fullAuto only when explicitly true", () => {
    expect(GrokAgentDriver.decodeConfig({ fullAuto: "yes" }).fullAuto).toBe(false);
    expect(GrokAgentDriver.decodeConfig({ fullAuto: true }).fullAuto).toBe(true);
  });
});

describe("Grok catalog probe", () => {
  it("stays static when initialize has only currentModelId", async () => {
    const inst = await GrokAgentDriver.create({
      instanceId: "grok-static-catalog",
      displayName: "Grok",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false, workspace: FAKE_CWD },
    });
    await inst.snapshot();
    expect(inst.models.options.map((o) => o.id)).toEqual(["grok-4.5"]);
    await inst.dispose();
  });

  it("uses initialize _meta.modelState.availableModels when a live list exists", async () => {
    const inst = await GrokAgentDriver.create({
      instanceId: "grok-live-catalog",
      displayName: "Grok",
      environment: { FAKE_ACP_INIT_MODELS: "grok-4.5,grok-4" },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false, workspace: FAKE_CWD },
    });
    expect(inst.models.options.map((o) => o.id)).toEqual(["grok-4.5"]);
    await inst.snapshot();
    expect(inst.models.options.map((o) => o.id)).toEqual(["grok-4.5", "grok-4"]);
    await inst.dispose();
  });
});

describe("ACP credentialEnv deny-by-default", () => {
  it("the core allowlist is the router keys the fleet already injects", () => {
    expect(DEFAULT_ACP_CREDENTIAL_ENV).toEqual(["OPENROUTER_API_KEY", "OMNIROUTER_API_KEY"]);
  });

  it("gemini opts into the keys it authenticates with; grok/hermes do not", () => {
    expect(GEMINI_CREDENTIAL_ENV).toEqual(["GEMINI_API_KEY", "GOOGLE_API_KEY"]);
    const grok = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "grok.ts"), "utf8");
    const hermes = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "hermes.ts"), "utf8");
    expect(grok).not.toMatch(/credentialEnv/);
    expect(hermes).not.toMatch(/credentialEnv/);
    expect(grok).toContain("delete env.XAI_API_KEY");
    expect(hermes).toContain("delete env.OPENAI_API_KEY");
    expect(hermes).toContain("delete env.HERMES_API_KEY");
  });

  it("strips planted secrets and foreign provider keys; router keys still pass", () => {
    const env: Record<string, string | undefined> = {
      PATH: "/bin",
      HOME: "/tmp/isolated-home",
      FAKE_ACP_AUTH_IDS: "cached_token",
      ...PLANTED,
    };
    applyAcpCredentialAllowlist(env);
    expect(env.SECRET_KEY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.XAI_API_KEY).toBeUndefined();
    expect(env.GEMINI_API_KEY).toBeUndefined();
    expect(env.OPENROUTER_API_KEY).toBe(PLANTED.OPENROUTER_API_KEY);
    expect(env.OMNIROUTER_API_KEY).toBe(PLANTED.OMNIROUTER_API_KEY);
    expect(env.PATH).toBe("/bin");
    expect(env.HOME).toBe("/tmp/isolated-home");
    expect(env.FAKE_ACP_AUTH_IDS).toBe("cached_token");
  });

  it("a driver credentialEnv extends the default allowlist, it does not replace it", () => {
    const env: Record<string, string | undefined> = { ...PLANTED };
    applyAcpCredentialAllowlist(env, GEMINI_CREDENTIAL_ENV);
    expect(env.GEMINI_API_KEY).toBe(PLANTED.GEMINI_API_KEY);
    expect(env.OPENROUTER_API_KEY).toBe(PLANTED.OPENROUTER_API_KEY);
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.SECRET_KEY).toBeUndefined();
  });
});

describe("ACP child env (fake driver, no transformEnv)", () => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;
  let scratch: string;

  beforeEach(() => {
    ensureDirs();
    scratch = mkdtempSync(join(tmpdir(), "omb-acp-cred-"));
    plantProviderKeys();
  });

  afterEach(async () => {
    unplantProviderKeys();
    delete process.env.FAKE_ACP_DUMP;
    delete process.env.GOOGLE_API_KEY;
    recorder?.stop();
    await instance?.dispose();
    rmSync(scratch, { recursive: true, force: true });
  });

  it("a forgotten transformEnv does not inherit planted secrets; router keys still pass", async () => {
    const dump = join(scratch, "dump.json");
    process.env.FAKE_ACP_DUMP = dump;
    instance = await BareAcpDriver.create({
      instanceId: "bare-cred",
      displayName: "Bare",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false, workspace: FAKE_CWD },
    });
    recorder = recordEvents(instance.adapter);
    await instance.adapter.sendTurn({ threadId: "t-bare-deny", text: "go" });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.env.SECRET_KEY).toBeUndefined();
    expect(seen.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(seen.env.OPENAI_API_KEY).toBeUndefined();
    expect(seen.env.XAI_API_KEY).toBeUndefined();
    expect(seen.env.GEMINI_API_KEY).toBeUndefined();
    expect(seen.env.OPENROUTER_API_KEY).toBe(PLANTED.OPENROUTER_API_KEY);
    expect(seen.env.OMNIROUTER_API_KEY).toBe(PLANTED.OMNIROUTER_API_KEY);
    expect(JSON.stringify(seen.argv)).not.toMatch(/planted-|canary/);
    expect(JSON.stringify(recorder.events)).not.toMatch(/planted-|canary/);
  });

  it("generateText rides the same allowlist as a turn spawn", async () => {
    const dump = join(scratch, "gen.json");
    instance = await BareAcpDriver.create({
      instanceId: "bare-gen",
      displayName: "Bare",
      environment: { FAKE_ACP_DUMP: dump },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false, workspace: FAKE_CWD },
    });
    expect(instance.generateText).toBeTypeOf("function");
    const text = await instance.generateText!("distill this");
    expect(text).toBe("User prefers concise replies. Last turn noted.");
    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.execArgv).toEqual(["exec", "-p", "distill this"]);
    expect(seen.env.SECRET_KEY).toBeUndefined();
    expect(seen.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(seen.env.OPENROUTER_API_KEY).toBe(PLANTED.OPENROUTER_API_KEY);
    expect(JSON.stringify(seen.execArgv)).not.toMatch(/planted-|canary/);
  });

  it("gemini still receives GEMINI_API_KEY / GOOGLE_API_KEY so it can auth", async () => {
    const dump = join(scratch, "gemini.json");
    process.env.GOOGLE_API_KEY = "planted-google-canary";
    process.env.FAKE_ACP_DUMP = dump;
    instance = await GeminiAgentDriver.create({
      instanceId: "gemini-cred",
      displayName: "Gemini",
      environment: { FAKE_ACP_AUTH_IDS: "oauth-personal,gemini-api-key,vertex-ai,gateway" },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false, workspace: FAKE_CWD },
    });
    recorder = recordEvents(instance.adapter);
    await instance.adapter.sendTurn({ threadId: "t-gemini-keep", text: "go" });
    await recorder.until((e) => e.type === "turn.completed");
    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.env.GEMINI_API_KEY).toBe(PLANTED.GEMINI_API_KEY);
    expect(seen.env.GOOGLE_API_KEY).toBe("planted-google-canary");
    expect(seen.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(seen.env.SECRET_KEY).toBeUndefined();
    expect(seen.env.NO_BROWSER).toBe("true");
    delete process.env.GOOGLE_API_KEY;
  });
});

describe("ACP turns (cross-platform fake CLI via process.execPath)", () => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;
  let scratch: string;

  const create = async (driver = GrokAgentDriver, mode?: string, fullAuto = false) => {
    if (mode) process.env.FAKE_ACP_MODE = mode;
    instance = await driver.create({
      instanceId: "acp-test",
      displayName: "ACP Test",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto, workspace: FAKE_CWD },
    });
    recorder = recordEvents(instance.adapter);
  };

  beforeEach(() => {
    ensureDirs();
    scratch = mkdtempSync(join(tmpdir(), "omb-acp-test-"));
  });

  afterEach(async () => {
    delete process.env.FAKE_ACP_MODE;
    delete process.env.FAKE_ACP_DUMP;
    delete process.env.XAI_API_KEY;
    recorder?.stop();
    await instance?.dispose();
    rmSync(scratch, { recursive: true, force: true });
  });

  it("normalizes a full turn into the canonical event sequence", async () => {
    await create();
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-happy", text: "hi", model: "grok-4.5" });
    await recorder.until((e) => e.type === "turn.completed");

    const types = recorder.events.map((e) => e.type);
    expect(types).toEqual([
      "turn.started",
      "session.started",
      "content.delta",
      "item.started", // tool tc-1
      "item.completed", // tool tc-1 done
      "thread.token-usage.updated",
      "item.completed", // assistant_text (summed) on settle
      "turn.completed",
    ]);
    expect(recorder.events.every((e) => e.turnId === turnId && e.provider === "grokAgent")).toBe(true);
    const usage = recorder.events.find((e) => e.type === "thread.token-usage.updated")!;
    expect(usage).toMatchObject({ input: 10, output: 5 });
    const text = recorder.events.find((e) => e.type === "item.completed" && (e as any).itemType === "assistant_text")!;
    expect((text as any).text).toBe("hello from fake acp");
    const done = recorder.events.at(-1)!;
    expect(done).toMatchObject({ type: "turn.completed", ok: true });
    expect(instance.adapter.hasSession("t-happy")).toBe(false);
  });

  it("passes ACP stdio flags and strips XAI_API_KEY from the child env", async () => {
    await create();
    const dump = join(scratch, "dump.json");
    process.env.FAKE_ACP_DUMP = dump;
    process.env.XAI_API_KEY = "xai-should-not-leak";

    await instance.adapter.sendTurn({ threadId: "t-hygiene", text: "go" });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv).toContain("agent");
    expect(seen.argv).toContain("stdio");
    expect(seen.argv).toContain("--permission-mode");
    expect(seen.env.XAI_API_KEY).toBeUndefined();
  });

  it("puts image bytes on session/prompt when the agent advertises image capability", async () => {
    await create();
    const dump = join(scratch, "dump.json");
    const img = join(scratch, "shot.png");
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    writeFileSync(img, png);
    writeFileSync(join(DATA_DIR, "config.json"), JSON.stringify({ github: { token: "ghp_secret_token" } }));
    process.env.FAKE_ACP_DUMP = dump;

    await instance.adapter.sendTurn({
      threadId: "t-image",
      text: "look",
      attachments: [{ path: img, mime: "image/png" }, { path: join(DATA_DIR, "config.json") }],
    });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    const prompt = seen.sessionPrompt.prompt;
    expect(prompt[0]).toEqual({ type: "text", text: "look" });
    expect(prompt[1]).toEqual({ type: "image", mimeType: "image/png", data: png.toString("base64") });
    expect(JSON.stringify(seen.argv)).not.toContain(png.toString("base64"));
    expect(JSON.stringify(seen)).not.toContain("ghp_secret_token");
  });

  it("keeps path refs only when the agent does not advertise image prompts", async () => {
    await create(GrokAgentDriver, "no-image");
    const dump = join(scratch, "dump.json");
    const img = join(scratch, "shot.png");
    writeFileSync(
      img,
      Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"),
    );
    process.env.FAKE_ACP_DUMP = dump;

    await instance.adapter.sendTurn({
      threadId: "t-no-vision",
      text: "look\n\nAttached files:\n- " + img,
      attachments: [{ path: img, mime: "image/png" }],
    });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.sessionPrompt.prompt).toEqual([{ type: "text", text: expect.stringContaining(img) }]);
    expect(JSON.stringify(seen.sessionPrompt.prompt)).not.toContain("iVBORw0KGgo");
  });

  it("a UTF-8 character split across stdout chunks does not drop the frame", async () => {
    await create(GrokAgentDriver, "split-utf8");
    await instance.adapter.sendTurn({ threadId: "t-utf8", text: "go" });
    await recorder.until((e) => e.type === "turn.completed");
    const delta = recorder.events.find((e) => e.type === "content.delta");
    expect(delta).toMatchObject({ streamKind: "assistant_text", delta: "hello café 你好 €" });
    const text = recorder.events.find((e) => e.type === "item.completed" && (e as { itemType?: string }).itemType === "assistant_text");
    expect(text).toMatchObject({ text: "hello café 你好 €" });
    expect(JSON.stringify(recorder.events)).not.toContain("\uFFFD");
  });

  it("Grok requireApproval + fullAuto does not skip the permission card", async () => {
    const dump = join(scratch, "dump.json");
    process.env.FAKE_ACP_DUMP = dump;
    await create(GrokAgentDriver, "permission", true);
    await instance.adapter.sendTurn({ threadId: "t-grok-require", text: "go", requireApproval: true });
    const opened = await recorder.until((e) => e.type === "request.opened");
    expect(opened).toMatchObject({ requestType: "permission", tool: "shell" });
    const seen = JSON.parse(readFileSync(dump, "utf8"));
    const modeAt = seen.argv.indexOf("--permission-mode");
    expect(modeAt).toBeGreaterThan(-1);
    expect(seen.argv[modeAt + 1]).toBe("default");
    expect(seen.argv).not.toContain("bypassPermissions");
    await instance.adapter.respondToRequest("t-grok-require", (opened as { requestId: string }).requestId, { behavior: "allow" });
    await recorder.until((e) => e.type === "turn.completed");
  });

  it("surfaces a permission ask as request.opened and completes once allowed", async () => {
    await create(GrokAgentDriver, "permission");
    await instance.adapter.sendTurn({ threadId: "t-perm", text: "go" });
    const opened = await recorder.until((e) => e.type === "request.opened");
    expect(opened).toMatchObject({ requestType: "permission", tool: "shell" });

    await instance.adapter.respondToRequest("t-perm", (opened as any).requestId, { behavior: "allow" });
    const resolved = await recorder.until((e) => e.type === "request.resolved");
    expect(resolved).toMatchObject({ behavior: "allow", source: "user" });
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: true });
  });

  it("emits a credential handoff for a sign-in permission and keeps secrets out", async () => {
    await create(GrokAgentDriver, "credential");
    await instance.adapter.sendTurn({ threadId: "t-cred", text: "go" });
    const opened = await recorder.until((e) => e.type === "request.opened");
    expect(opened).toMatchObject({ requestType: "credential", tool: "shell" });
    expect(JSON.stringify(opened)).not.toContain("hunter2");
    await instance.adapter.respondToRequest("t-cred", (opened as any).requestId, { behavior: "allow" });
    await recorder.until((e) => e.type === "request.resolved");
    await recorder.until((e) => e.type === "turn.completed");
    expect(JSON.stringify(recorder.events)).not.toContain("hunter2");
  });

  it("grok fails closed when the CLI advertises no cached_token (needs login)", async () => {
    await create(GrokAgentDriver, "no-auth");
    await instance.adapter.sendTurn({ threadId: "t-auth", text: "go" });
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: false, stopReason: "auth_required" });
    const err = recorder.events.find((e) => e.type === "runtime.error")!;
    expect(err.message).toMatch(/not signed in/);
  });

  it("gemini proceeds through a missing auth method (lenient login)", async () => {
    await create(GeminiAgentDriver, "no-auth");
    await instance.adapter.sendTurn({ threadId: "t-lenient", text: "go" });
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: true });
    expect(recorder.events.some((e) => e.provider === "geminiAgent")).toBe(true);
  });

  it("rejects a second turn while one is in flight", async () => {
    await create(GrokAgentDriver, "hang");
    await instance.adapter.sendTurn({ threadId: "t-busy", text: "one" });
    await recorder.until((e) => e.type === "session.started");
    await expect(instance.adapter.sendTurn({ threadId: "t-busy", text: "two" })).rejects.toThrow(/already running/);
    await instance.adapter.interruptTurn("t-busy");
    await recorder.until((e) => e.type === "turn.completed");
  });

  it("interrupt settles a hung turn as cancelled", async () => {
    await create(GrokAgentDriver, "hang");
    await instance.adapter.sendTurn({ threadId: "t-int", text: "go" });
    await recorder.until((e) => e.type === "session.started");
    await instance.adapter.interruptTurn("t-int");
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ type: "turn.completed" });
  });

  it("an exit before result becomes runtime.error + failed turn", async () => {
    await create(GrokAgentDriver, "exit-early");
    await instance.adapter.sendTurn({ threadId: "t-crash", text: "go" });
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: false });
    expect(recorder.events.some((e) => e.type === "runtime.error")).toBe(true);
  });

  it("dumps composio on session/new and session/load when enabled", async () => {
    await create();
    const dump = join(scratch, "dump.json");
    process.env.FAKE_ACP_DUMP = dump;
    const composioKey = "ck_acp_secret";
    const composio = {
      command: process.execPath,
      args: ["/fake/composio-proxy.js"],
      env: { OMB_COMPOSIO_KEY: composioKey, OMB_ALLOWED_TOOLKITS: "googledrive" },
    };

    await instance.adapter.sendTurn({ threadId: "t-composio-new", text: "go", integrations: { composio } });
    await recorder.until((e) => e.type === "turn.completed" && e.threadId === "t-composio-new");
    const started = JSON.parse(readFileSync(dump, "utf8"));
    const newNames = (started.sessionNew?.mcpServers ?? []).map((s: { name: string }) => s.name);
    expect(newNames).toContain("composio");
    expect(JSON.stringify(started.argv)).not.toContain(composioKey);

    await instance.adapter.sendTurn({
      threadId: "t-composio-load",
      text: "again",
      resumeCursor: "fake-acp-session",
      integrations: { composio },
    });
    await recorder.until((e) => e.type === "turn.completed" && e.threadId === "t-composio-load");
    const resumed = JSON.parse(readFileSync(dump, "utf8"));
    const loadNames = (resumed.sessionLoad?.mcpServers ?? []).map((s: { name: string }) => s.name);
    expect(loadNames).toContain("composio");
    expect(JSON.stringify(resumed.argv)).not.toContain(composioKey);
  });

  it("dumps memory on session/new when enabled", async () => {
    await create();
    const dump = join(scratch, "dump.json");
    process.env.FAKE_ACP_DUMP = dump;
    const token = "mem_acp_secret";
    await instance.adapter.sendTurn({
      threadId: "t-memory-new",
      text: "go",
      integrations: {
        memory: {
          command: process.execPath,
          args: ["/fake/memory-proxy.js"],
          env: { OMB_BOT_ID: "b1", OMB_COMMS_TOKEN: token },
        },
      },
    });
    await recorder.until((e) => e.type === "turn.completed" && e.threadId === "t-memory-new");
    const started = JSON.parse(readFileSync(dump, "utf8"));
    const newNames = (started.sessionNew?.mcpServers ?? []).map((s: { name: string }) => s.name);
    expect(newNames).toContain("memory");
    expect(JSON.stringify(started.argv)).not.toContain(token);
  });

  it("dumps workspace on session/new when enabled", async () => {
    await create();
    const dump = join(scratch, "dump.json");
    process.env.FAKE_ACP_DUMP = dump;
    const token = "ws_acp_secret";
    await instance.adapter.sendTurn({
      threadId: "t-workspace-new",
      text: "go",
      integrations: {
        workspace: {
          command: process.execPath,
          args: ["/fake/workspace-proxy.js"],
          env: { OMB_BOT_ID: "b1", OMB_COMMS_TOKEN: token },
        },
      },
    });
    await recorder.until((e) => e.type === "turn.completed" && e.threadId === "t-workspace-new");
    const started = JSON.parse(readFileSync(dump, "utf8"));
    const newNames = (started.sessionNew?.mcpServers ?? []).map((s: { name: string }) => s.name);
    expect(newNames).toContain("workspace");
    expect(JSON.stringify(started.argv)).not.toContain(token);
  });
});

describe("ACP snapshot (cross-platform process launch)", () => {
  it("a missing binary is unavailable", async () => {
    const instance = await GrokAgentDriver.create({
      instanceId: "grok-missing",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: { cli: "definitely-not-a-real-grok-binary", fullAuto: false },
    });
    const snap = await instance.snapshot();
    expect(snap.state).toBe("unavailable");
    await instance.dispose();
  });
});
