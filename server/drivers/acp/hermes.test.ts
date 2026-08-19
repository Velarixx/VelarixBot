// Hermes driver contract tests, run against the scripted fake ACP CLI in
// server/testing/fake-hermes-cli.ts, advertising the auth methods the REAL
// hermes v0.20.4 ACP adapter advertises: the resolved pool provider (e.g.
// openai-codex — the ChatGPT/Codex subscription) plus the unconditional
// terminal setup method (hermes-setup, type "terminal"). Mirrors
// acp.test.ts for the shared runtime, plus the Hermes-specific quirks:
// the v0.20.4 spawn grammar (`[-m <model>] acp` — never the retired
// `--approval-policy … acp stdio`, never `--yolo`), OPENAI_API_KEY stripped
// from the child env, credential-pool auth that needs NO ~/.hermes/auth.json
// on disk and NEVER says `hermes login` (that command was removed — the
// v0.20.1 field failure), fails closed when only the setup method is
// advertised (no pool credentials), and the expired-token shape (auth ok,
// session/prompt -32000) settling as auth_required instead of hanging.
//
// This suite runs on Windows too: the fake CLI is a `.ts` path, which
// resolveCliCommand always executes via process.execPath on every platform —
// no shebang, no chmodSync, no posixOnly.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureDirs, NATIVE_DIR } from "../../config.ts";
import type { ProviderInstance } from "../../contracts.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
import { HermesAgentDriver } from "./hermes.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "testing", "fake-hermes-cli.ts");
// What real hermes v0.20.4 advertises when the credential pool resolves:
// the provider as an agent-managed method + the always-on terminal setup.
const POOL_AUTH_IDS = "openai-codex,hermes-setup:terminal";
// …and when NO credentials resolve: only the terminal setup method.
const SETUP_ONLY_AUTH_IDS = "hermes-setup:terminal";
// A clearly-fake credential-pool store, shaped like `hermes auth add
// openai-codex` output — constructed at runtime, never a real secret.
const FAKE_POOL_STORE = JSON.stringify({
  version: 1,
  credential_pool: {
    "openai-codex": [
      {
        id: "fake01",
        label: "velarixbot-test",
        auth_type: "oauth",
        source: "manual:device_code",
        access_token: "fake-access-token-not-a-real-secret",
        refresh_token: "fake-refresh-token-not-a-real-secret",
      },
    ],
  },
});
// Strict-grammar hermes, shaped like the tagged binary (v0.20.4): rejects any
// argv that isn't exactly what hermes.ts emits (usage + exit 2, like the real
// CLI — including the OLD `--approval-policy … acp stdio` grammar), then
// speaks ACP. The rc.12/rc.14 field failures shipped because only
// accept-anything fakes ever saw the argv.
const STRICT_CLI = FAKE_CLI;

const exchangeWithStrictHermes = (
  args: string[],
  requests: Array<Record<string, unknown>>,
  lastResponseId: number,
) =>
  new Promise<any[]>((resolve, reject) => {
    const child = spawn(process.execPath, [STRICT_CLI, ...args], {
      env: {
        ...process.env,
        FAKE_ACP_AUTH_IDS: POOL_AUTH_IDS,
        FAKE_ACP_SESSION_MODELS: "gpt-5.6-sol,gpt-5.5",
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const frames: any[] = [];
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      if (error) reject(error);
      else resolve(frames);
    };
    const timer = setTimeout(
      () => finish(new Error(`timed out waiting for Hermes ACP frames: ${stderr}`)),
      5_000,
    );
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      let newline: number;
      while ((newline = stdout.indexOf("\n")) !== -1) {
        const line = stdout.slice(0, newline);
        stdout = stdout.slice(newline + 1);
        if (!line.trim()) continue;
        const frame = JSON.parse(line);
        frames.push(frame);
        if (frame.id === lastResponseId) finish();
      }
    });
    child.on("error", finish);
    child.on("close", (code) => {
      if (!settled) finish(new Error(`Hermes ACP fixture exited ${code}: ${stderr}`));
    });
    for (const request of requests) child.stdin.write(JSON.stringify(request) + "\n");
  });

describe("Hermes decodeConfig", () => {
  it("defaults to the hermes binary", () => {
    expect(HermesAgentDriver.decodeConfig({})).toEqual({ cli: "hermes", fullAuto: false, workspace: undefined });
    expect(HermesAgentDriver.decodeConfig(undefined)).toEqual({ cli: "hermes", fullAuto: false, workspace: undefined });
  });

  it("fullAuto only when explicitly true", () => {
    expect(HermesAgentDriver.decodeConfig({ fullAuto: "yes" }).fullAuto).toBe(false);
    expect(HermesAgentDriver.decodeConfig({ fullAuto: true }).fullAuto).toBe(true);
  });

  it("catalogs the static v1 models with gpt-5.6-sol as the default", () => {
    expect(HermesAgentDriver.models.default).toBe("gpt-5.6-sol");
    expect(HermesAgentDriver.models.options.map((o) => o.id)).toEqual(["gpt-5.6-sol", "gpt-5.5"]);
  });

  it("keeps the static catalog when v0.20.4 initialize carries no model catalog", async () => {
    const inst = await HermesAgentDriver.create({
      instanceId: "hermes-static-catalog",
      displayName: "Hermes",
      environment: { FAKE_ACP_AUTH_IDS: POOL_AUTH_IDS, FAKE_ACP_SESSION_MODELS: "gpt-5.6-sol,gpt-5.5" },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    await inst.snapshot();
    expect(inst.models.options.map((o) => o.id)).toEqual(["gpt-5.6-sol", "gpt-5.5"]);
    await inst.dispose();
  });

  it("takes the active model from the v0.20.4 session/new models frame", async () => {
    const inst = await HermesAgentDriver.create({
      instanceId: "hermes-session-model",
      displayName: "Hermes",
      environment: { FAKE_ACP_AUTH_IDS: POOL_AUTH_IDS, FAKE_ACP_SESSION_MODELS: "gpt-5.4,gpt-5.6-sol" },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    const events = recordEvents(inst.adapter);
    await inst.adapter.sendTurn({ threadId: "hermes-session-model", text: "hi", model: "requested-model" });
    const started = await events.until((event) => event.type === "session.started");
    expect(started).toMatchObject({ model: "gpt-5.4" });
    await events.until((event) => event.type === "turn.completed");
    events.stop();
    await inst.dispose();
  });

  it("is user-portable: bare PATH name by default, config.cli override, no baked-in install path", () => {
    // the default is a bare binary name resolved on PATH — never a directory
    const cli = HermesAgentDriver.decodeConfig({}).cli;
    expect(cli).toBe("hermes");
    expect(cli).not.toMatch(/[\\/]/);
    // a per-instance override points at a custom binary verbatim
    expect(HermesAgentDriver.decodeConfig({ cli: "/opt/custom/hermes" }).cli).toBe("/opt/custom/hermes");
    // and the driver source carries no developer-machine absolute paths;
    // the auth-store cache hint must stay homedir-relative (~/.hermes)
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "hermes.ts"), "utf8");
    expect(source).not.toMatch(/[A-Za-z]:\\/); // no Windows drive letters
    expect(source).not.toMatch(/(\/Users\/|\/home\/|\\Users\\)/);
    expect(source).toContain("homedir()");
    expect(source).toContain('".hermes"');
  });
});

describe("Hermes turns (fake CLI)", () => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;
  let scratch: string;

  const create = async (opts: { mode?: string; fullAuto?: boolean; env?: Record<string, string> } = {}) => {
    instance = await HermesAgentDriver.create({
      instanceId: "hermes-test",
      displayName: "Hermes Test",
      environment: {
        FAKE_ACP_AUTH_IDS: POOL_AUTH_IDS,
        FAKE_ACP_SESSION_MODELS: "gpt-5.6-sol,gpt-5.5",
        ...(opts.mode ? { FAKE_ACP_MODE: opts.mode } : {}),
        ...opts.env,
      },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: opts.fullAuto === true },
    });
    recorder = recordEvents(instance.adapter);
  };

  beforeEach(() => {
    ensureDirs();
    scratch = mkdtempSync(join(tmpdir(), "omb-hermes-test-"));
  });

  afterEach(async () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.HERMES_API_KEY;
    recorder?.stop();
    await instance?.dispose();
    rmSync(scratch, { recursive: true, force: true });
  });

  it("normalizes a full turn into the canonical event sequence and tees hermes.acp", async () => {
    await create();
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-hermes-happy", text: "hi", model: "gpt-5.6-sol" });
    await recorder.until((e) => e.type === "turn.completed");

    expect(recorder.events.map((e) => e.type)).toEqual([
      "turn.started",
      "session.started",
      "content.delta",
      "item.started",
      "item.completed",
      "item.completed", // assistant_text (summed) on settle
      "turn.completed",
    ]);
    expect(recorder.events.every((e) => e.turnId === turnId && e.provider === "hermesAgent")).toBe(true);
    const text = recorder.events.find((e) => e.type === "item.completed" && (e as any).itemType === "assistant_text")!;
    expect((text as any).text).toBe("hello from fake acp");
    // v0.20.4 returns PromptResponse.usage, not the legacy fixture's _meta.
    // The current production driver does not normalize that field; this test
    // intentionally avoids fabricating a token event the tagged frame cannot.
    expect(recorder.events.some((e) => e.type === "thread.token-usage.updated")).toBe(false);
    expect(recorder.events.at(-1)).toMatchObject({ type: "turn.completed", ok: true });
    expect(instance.adapter.hasSession("t-hermes-happy")).toBe(false);

    // native tee is labeled with the Hermes source, both directions
    const native = readFileSync(join(NATIVE_DIR, "t-hermes-happy.ndjson"), "utf8");
    expect(native).toContain('"source":"hermes.acp"');
    expect(native).toContain('"dir":"out"');
    expect(native).toContain('"dir":"in"');
  });

  it("pins the v0.20.4 argv `-m <model> acp` — no --approval-policy, no stdio — and strips key env vars", async () => {
    const dump = join(scratch, "dump.json");
    await create({ env: { FAKE_ACP_DUMP: dump } });
    process.env.OPENAI_API_KEY = "sk-should-not-leak";
    process.env.HERMES_API_KEY = "hermes-should-not-leak";

    await instance.adapter.sendTurn({ threadId: "t-hermes-argv", text: "go", model: "gpt-5.5" });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv).toEqual(["-m", "gpt-5.5", "acp"]);
    // the retired grammar (rejected by hermes v0.20.4 with usage + exit 2)
    // must never come back
    expect(seen.argv).not.toContain("--approval-policy");
    expect(seen.argv).not.toContain("stdio");
    expect(seen.env.OPENAI_API_KEY).toBeUndefined();
    expect(seen.env.HERMES_API_KEY).toBeUndefined();
    expect(JSON.stringify(seen)).not.toContain("should-not-leak");
  });

  it("fullAuto never reaches the argv — bare `acp`, no --yolo (P0.1), no -m without a model", async () => {
    const dump = join(scratch, "dump.json");
    await create({ fullAuto: true, env: { FAKE_ACP_DUMP: dump } });

    await instance.adapter.sendTurn({ threadId: "t-hermes-auto", text: "go" });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv).toEqual(["acp"]);
    // fullAuto auto-allows at the ACP permission bridge — never via the
    // CLI-level --yolo bypass, which would skip session/request_permission
    expect(seen.argv).not.toContain("--yolo");
  });

  it("surfaces a permission ask and a DENY still completes the turn", async () => {
    await create({ mode: "permission" });
    await instance.adapter.sendTurn({ threadId: "t-hermes-deny", text: "go" });
    const opened = await recorder.until((e) => e.type === "request.opened");
    expect(opened).toMatchObject({ requestType: "permission", tool: "shell" });

    await instance.adapter.respondToRequest("t-hermes-deny", (opened as any).requestId, { behavior: "deny" });
    const resolved = await recorder.until((e) => e.type === "request.resolved");
    expect(resolved).toMatchObject({ behavior: "deny", source: "user" });
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: true });
  });

  it("emits a credential handoff for a sign-in permission and keeps secrets out", async () => {
    await create({ mode: "credential" });
    await instance.adapter.sendTurn({ threadId: "t-hermes-cred", text: "go" });
    const opened = await recorder.until((e) => e.type === "request.opened");
    expect(opened).toMatchObject({ requestType: "credential", tool: "shell" });
    expect(JSON.stringify(opened)).not.toContain("hunter2");
    await instance.adapter.respondToRequest("t-hermes-cred", (opened as any).requestId, { behavior: "allow" });
    await recorder.until((e) => e.type === "request.resolved");
    await recorder.until((e) => e.type === "turn.completed");
    expect(JSON.stringify(recorder.events)).not.toContain("hunter2");
  });

  it("a pool credential is enough: ~/.hermes holds only plans/, openai-codex advertised → no login note", async () => {
    // the v0.20.1 field failure: Dyon HAD authenticated (`hermes auth` shows
    // openai-codex oauth) yet every turn demanded the removed `hermes login`
    // because the driver required chatgpt-oauth + a legacy auth.json. His
    // disk shape, verified: ~/.hermes contains ONLY plans\ — no auth.json
    // anywhere, credentials hydrated by Bitwarden Secrets Manager at process
    // start. The handshake is the truth: an advertised pool provider must
    // complete the turn with zero login copy, whatever is (not) on disk.
    const dump = join(scratch, "dump.json");
    const hermesDir = join(homedir(), ".hermes");
    rmSync(hermesDir, { recursive: true, force: true });
    mkdirSync(join(hermesDir, "plans"), { recursive: true }); // the exact field shape
    await create({ env: { FAKE_ACP_DUMP: dump } });
    await instance.adapter.sendTurn({ threadId: "t-hermes-pool", text: "go", model: "gpt-5.6-sol" });
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: true });
    expect(recorder.events.some((e) => e.type === "runtime.error")).toBe(false);
    const all = JSON.stringify(recorder.events);
    expect(all).not.toContain("hermes login");
    expect(all).not.toContain("not signed in");
    // and the driver authenticated with the subscription provider it found
    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.authenticate).toEqual({ methodId: "openai-codex" });
  });

  it("whatever provider the pool resolved is accepted — never the terminal setup method", async () => {
    // hermes advertises the CURRENTLY configured provider; a pool that
    // resolved e.g. anthropic must still authenticate (the advertised id is
    // the only one hermes accepts), while hermes-setup — advertised even
    // with zero credentials — must never be picked as a login.
    const dump = join(scratch, "dump.json");
    await create({ env: { FAKE_ACP_AUTH_IDS: "hermes-setup:terminal,anthropic", FAKE_ACP_DUMP: dump } });
    await instance.adapter.sendTurn({ threadId: "t-hermes-otherpool", text: "go" });
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: true });
    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.authenticate).toEqual({ methodId: "anthropic" });
  });

  it("fails closed with the `hermes auth` message when only the setup method is advertised (no pool credentials)", async () => {
    await create({ env: { FAKE_ACP_AUTH_IDS: SETUP_ONLY_AUTH_IDS } });
    await instance.adapter.sendTurn({ threadId: "t-hermes-noauth", text: "go" });
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: false, stopReason: "auth_required" });
    const err = recorder.events.find((e) => e.type === "runtime.error")!;
    expect(err.message).toMatch(/hermes auth/);
    expect(err.message).toMatch(/hermes setup/);
    // the removed command must never come back into the failure copy
    expect(err.message).not.toMatch(/hermes login/);
  });

  it("fails closed when authenticate itself errors (dead login)", async () => {
    await create({ mode: "auth-error" });
    await instance.adapter.sendTurn({ threadId: "t-hermes-autherr", text: "go" });
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: false, stopReason: "auth_required" });
  });

  it("an expired token at session/prompt settles as auth_required — no hang, no `hermes login`", async () => {
    await create({ mode: "expired-token" });
    await instance.adapter.sendTurn({ threadId: "t-hermes-expired", text: "go" });
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: false, stopReason: "auth_required" });
    const err = recorder.events.find((e) => e.type === "runtime.error")!;
    expect(err.message).toMatch(/hermes auth/);
    expect(err.message).not.toMatch(/hermes login/);
    expect(instance.adapter.hasSession("t-hermes-expired")).toBe(false);
  });

  it("a write to a closed child stdin settles the turn — never an unhandled EPIPE crash (rc.12)", async () => {
    // The fake closes its actual stdin pipe before replying, so the driver's
    // authenticate write deterministically lands on a closed pipe on Windows
    // too. Windows observes the process-exit fallback before its pipe error;
    // both paths must fail the turn without an unhandled EPIPE server crash.
    await create({ mode: "stdin-close" });
    await instance.adapter.sendTurn({ threadId: "t-hermes-epipe", text: "go" });
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({
      ok: false,
      stopReason: process.platform === "win32" ? "exit_before_result" : "stdin_error",
    });
    expect(recorder.events.map((e) => e.type)).toEqual(["turn.started", "runtime.error", "turn.completed"]);
    const err = recorder.events.find((e) => e.type === "runtime.error")!;
    expect(err.message).toContain(process.platform === "win32" ? "exited 0 before the prompt result" : "stdin write failed");
    expect(instance.adapter.hasSession("t-hermes-epipe")).toBe(false);
  });

  it("interrupt settles a hung turn", async () => {
    await create({ mode: "hang" });
    await instance.adapter.sendTurn({ threadId: "t-hermes-int", text: "go" });
    await recorder.until((e) => e.type === "session.started");
    await instance.adapter.interruptTurn("t-hermes-int");
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ type: "turn.completed" });
    expect(instance.adapter.hasSession("t-hermes-int")).toBe(false);
  });

  it("mounts mcpServers on session/new AND session/load without secrets in argv", async () => {
    const dump = join(scratch, "dump.json");
    await create({ env: { FAKE_ACP_DUMP: dump } });
    const composioKey = "ck_hermes_secret";
    const memoryToken = "mem_hermes_secret";
    const integrations = {
      composio: {
        command: process.execPath,
        args: ["/fake/composio-proxy.js"],
        env: { OMB_COMPOSIO_KEY: composioKey, OMB_ALLOWED_TOOLKITS: "googledrive" },
      },
      memory: {
        command: process.execPath,
        args: ["/fake/memory-proxy.js"],
        env: { OMB_BOT_ID: "b1", OMB_COMMS_TOKEN: memoryToken },
      },
    };

    await instance.adapter.sendTurn({ threadId: "t-hermes-mcp-new", text: "go", integrations });
    await recorder.until((e) => e.type === "turn.completed" && e.threadId === "t-hermes-mcp-new");
    const started = JSON.parse(readFileSync(dump, "utf8"));
    const newNames = (started.sessionNew?.mcpServers ?? []).map((s: { name: string }) => s.name);
    expect(newNames).toEqual(expect.arrayContaining(["composio", "memory"]));
    expect(JSON.stringify(started.argv)).not.toContain(composioKey);
    expect(JSON.stringify(started.argv)).not.toContain(memoryToken);

    await instance.adapter.sendTurn({
      threadId: "t-hermes-mcp-load",
      text: "again",
      resumeCursor: "fake-acp-session",
      integrations,
    });
    await recorder.until((e) => e.type === "turn.completed" && e.threadId === "t-hermes-mcp-load");
    const resumed = JSON.parse(readFileSync(dump, "utf8"));
    const loadNames = (resumed.sessionLoad?.mcpServers ?? []).map((s: { name: string }) => s.name);
    expect(loadNames).toEqual(expect.arrayContaining(["composio", "memory"]));
    expect(JSON.stringify(resumed.argv)).not.toContain(composioKey);
    expect(JSON.stringify(resumed.argv)).not.toContain(memoryToken);
  });
});

describe("Hermes spawn grammar (strict fake CLI)", () => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;

  const createStrict = async (opts: { fullAuto?: boolean; reject?: boolean; grammar?: string } = {}) => {
    instance = await HermesAgentDriver.create({
      instanceId: "hermes-strict",
      displayName: "Hermes Strict",
      environment: {
        FAKE_ACP_AUTH_IDS: POOL_AUTH_IDS,
        FAKE_ACP_SESSION_MODELS: "gpt-5.6-sol,gpt-5.5",
        ...(opts.reject ? { FAKE_HERMES_GRAMMAR: "reject" } : {}),
        ...(opts.grammar ? { FAKE_HERMES_GRAMMAR: opts.grammar } : {}),
      },
      enabled: true,
      config: { cli: STRICT_CLI, fullAuto: opts.fullAuto === true },
    });
    recorder = recordEvents(instance.adapter);
  };

  afterEach(async () => {
    recorder?.stop();
    await instance?.dispose();
  });

  it("emits the documented v0.20.4 initialize, session model/mode, and prompt usage frames", async () => {
    const frames = await exchangeWithStrictHermes(
      ["-m", "gpt-5.6-sol", "acp"],
      [
        { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } },
        { jsonrpc: "2.0", id: 2, method: "authenticate", params: { methodId: "openai-codex" } },
        { jsonrpc: "2.0", id: 3, method: "session/new", params: { cwd: process.cwd(), mcpServers: [] } },
        {
          jsonrpc: "2.0",
          id: 4,
          method: "session/prompt",
          params: { sessionId: "fake-acp-session", prompt: [{ type: "text", text: "hi" }] },
        },
      ],
      4,
    );
    const response = (id: number) => frames.find((frame) => frame.id === id)?.result;
    expect(response(1)).toEqual({
      protocolVersion: 1,
      agentInfo: { name: "hermes-agent", version: "0.20.4" },
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true },
        sessionCapabilities: { fork: {}, list: {}, resume: {} },
      },
      authMethods: [
        {
          id: "openai-codex",
          name: "openai-codex runtime credentials",
          description: "Authenticate Hermes using the currently configured openai-codex runtime credentials.",
        },
        {
          id: "hermes-setup",
          name: "Configure Hermes provider",
          description:
            "Open Hermes' interactive model/provider setup in a terminal. Use this when Hermes has not been configured on this machine yet.",
          type: "terminal",
          args: ["--setup"],
        },
      ],
    });
    expect(response(1)).not.toHaveProperty("_meta");
    expect(response(3)).toEqual({
      sessionId: "fake-acp-session",
      models: {
        availableModels: [
          { modelId: "gpt-5.6-sol", name: "gpt-5.6-sol" },
          { modelId: "gpt-5.5", name: "gpt-5.5" },
        ],
        currentModelId: "gpt-5.6-sol",
      },
      modes: {
        availableModes: [
          { id: "default", name: "Default" },
          { id: "accept_edits", name: "Accept Edits" },
          { id: "dont_ask", name: "Don't Ask" },
        ],
        currentModeId: "default",
      },
    });
    expect(response(4)).toEqual({
      stopReason: "end_turn",
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    });
  });

  it("the exact argv the driver emits (with -m) is accepted and completes a turn", async () => {
    await createStrict();
    await instance.adapter.sendTurn({ threadId: "t-strict-model", text: "hi", model: "gpt-5.6-sol" });
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: true, stopReason: null });
  });

  it("the fullAuto / no-model argv is accepted too", async () => {
    await createStrict({ fullAuto: true });
    await instance.adapter.sendTurn({ threadId: "t-strict-auto", text: "hi" });
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: true, stopReason: null });
  });

  it("the OLD argv (--approval-policy … acp stdio) is rejected by the tagged fake: usage + exit 2", async () => {
    // the v0.20.4 tagged binary rejects the retired grammar exactly like
    // this — if the driver ever regresses to it, the strict-fake turn and
    // snapshot tests above fail, and this pins WHY: exit 2 on that argv
    const oldArgv = ["--approval-policy", "acp", "-m", "gpt-5.6-sol", "acp", "stdio"];
    const { code, stderr } = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [STRICT_CLI, ...oldArgv], {
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
      });
      let stderr = "";
      child.stderr.on("data", (c) => (stderr += c));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stderr }));
    });
    expect(code).toBe(2);
    expect(stderr).toContain("unrecognized command or arguments");
    expect(stderr).toContain("usage: hermes");
  });

  it("a hermes that rejects the argv (the field binary) fails the turn loudly, never silently", async () => {
    await createStrict({ reject: true });
    await instance.adapter.sendTurn({ threadId: "t-strict-reject", text: "hi", model: "gpt-5.6-sol" });
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: false, stopReason: "exit_before_result" });
    expect(recorder.events.some((e) => e.type === "turn.completed" && (e as any).ok)).toBe(false);
    const err = recorder.events.find((e) => e.type === "runtime.error")!;
    expect(err.message).toContain("exited 2");
    expect(err.message).toContain("[global-options]"); // the CLI's documented usage grammar, surfaced
  });

  it("does not invent `hermes exec -p` success: v0.20.4 rejects the undocumented command", async () => {
    await createStrict();
    await expect(instance.generateText!("distill")).rejects.toThrow(/unrecognized command or arguments/);
  });

  it("snapshot on a binary that rejects the argv reports the real usage/exit — never a login hint, whatever is on disk", async () => {
    // the rc.14 field shape: the CLI rejects the spawn argv (usage + exit
    // 2). That is a CLI/argv fault whatever the credential state — blaming
    // login sent the field user to a removed command. And since the probe
    // never completed a handshake, the auth state is UNKNOWN: it must be
    // omitted, never fabricated from the presence/absence of a pool file.
    const authFile = join(homedir(), ".hermes", "auth.json");
    rmSync(authFile, { force: true });
    await createStrict({ reject: true });
    const assertArgvFault = (snap: Awaited<ReturnType<typeof instance.snapshot>>) => {
      expect(snap.state).toBe("unavailable");
      expect(snap.authenticated).toBeUndefined();
      expect(snap.reason).toContain("does not speak ACP");
      expect(snap.reason).toContain("wrong or outdated CLI");
      expect(snap.reason).toContain("exited 2"); // the CLI's real exit …
      expect(snap.reason).toContain("usage: hermes"); // … and its own usage
      expect(snap.reason).toContain("Hermes Agent v0.20.4 (2026.8.18)"); // --version alone no longer means available
      expect(snap.reason).toContain("fake-hermes-cli"); // resolved path — which binary is this?
      expect(snap.reason).not.toContain("hermes login");
      expect(snap.reason).not.toContain("not signed in");
    };
    try {
      assertArgvFault(await instance.snapshot()); // nothing on disk
      mkdirSync(dirname(authFile), { recursive: true });
      writeFileSync(authFile, FAKE_POOL_STORE); // valid pool creds on disk
      assertArgvFault(await instance.snapshot()); // same fault, same copy
    } finally {
      rmSync(authFile, { force: true });
    }
  });

  it("`hermes auth add` un-sticks a failed probe immediately — the 60s identity cache never outlives the pool", async () => {
    // reject-signed-out models a credential-less binary that refuses ACP
    // mode until the pool store ~/.hermes/auth.json exists. The identity
    // cache is keyed on the pool hint (`hermes auth list`, file stat as
    // fallback while the credential-less binary rejects even that), so the
    // snapshot right after `hermes auth add …` re-probes and recovers
    // instead of serving the stale failure for the rest of the 60s TTL. The
    // credential-less failure itself still reports the CLI's own usage/exit.
    const authFile = join(homedir(), ".hermes", "auth.json");
    rmSync(authFile, { force: true });
    await createStrict({ grammar: "reject-signed-out" });
    try {
      const noCreds = await instance.snapshot();
      expect(noCreds.state).toBe("unavailable");
      expect(noCreds.reason).toContain("exited 2");
      expect(noCreds.reason).not.toContain("hermes login");

      mkdirSync(dirname(authFile), { recursive: true });
      writeFileSync(authFile, FAKE_POOL_STORE);
      const withCreds = await instance.snapshot();
      expect(withCreds).toMatchObject({
        state: "available",
        authenticated: true,
        version: "Hermes Agent v0.20.4 (2026.8.18)",
      });
    } finally {
      rmSync(authFile, { force: true });
    }
  });

  it("snapshot stays available when the binary accepts the argv and speaks ACP", async () => {
    await createStrict();
    expect(await instance.snapshot()).toMatchObject({
      state: "available",
      authenticated: true,
      version: "Hermes Agent v0.20.4 (2026.8.18)",
    });
  });
});

describe("Hermes generateText (v0.20.4 command honesty)", () => {
  it("rejects the production helper's undocumented `hermes exec -p` argv without leaking keys", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-hermes-gen-"));
    const dump = join(scratch, "dump.json");
    process.env.OPENAI_API_KEY = "sk-should-not-leak";
    const instance = await HermesAgentDriver.create({
      instanceId: "hermes-gen",
      displayName: undefined,
      environment: { FAKE_ACP_DUMP: dump },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    try {
      expect(instance.generateText).toBeTypeOf("function");
      await expect(instance.generateText!("distill this")).rejects.toThrow(/unrecognized command or arguments/);
      // Rejection happens at the strict argv gate before the ACP fake can
      // write a dump; the planted key is therefore neither persisted nor
      // surfaced in the error path.
      expect(existsSync(dump)).toBe(false);
    } finally {
      delete process.env.OPENAI_API_KEY;
      await instance.dispose();
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("rejects when the one-shot exec fails (missing binary)", async () => {
    const instance = await HermesAgentDriver.create({
      instanceId: "hermes-gen-missing",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: { cli: "definitely-not-a-real-hermes-binary", fullAuto: false },
    });
    await expect(instance.generateText!("hi")).rejects.toThrow();
    await instance.dispose();
  });
});

describe("Hermes snapshot", () => {
  it("a missing binary is unavailable with a CLI-not-found reason", async () => {
    const instance = await HermesAgentDriver.create({
      instanceId: "hermes-missing",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: { cli: "definitely-not-a-real-hermes-binary", fullAuto: false },
    });
    const snap = await instance.snapshot();
    expect(snap.state).toBe("unavailable");
    expect(snap.reason).toContain("CLI not found");
    await instance.dispose();
  });

  it("authenticated comes from the ACP handshake — an advertised pool provider with NO ~/.hermes/auth.json is signed in", async () => {
    // the v0.20.4 contract: hermes advertises the resolved pool provider as
    // an auth method iff its credential pool resolves (env-seeded, imported,
    // profile-scoped, or secret-manager-hydrated — Bitwarden Secrets Manager
    // injects provider keys at process start with nothing under ~/.hermes) —
    // no file on disk is required, and requiring one was the field failure.
    // HOME is the per-suite sandbox (testing/setup.ts); recreate the field
    // machine's shape: ~/.hermes with only plans\, no auth.json.
    const hermesDir = join(homedir(), ".hermes");
    rmSync(hermesDir, { recursive: true, force: true });
    mkdirSync(join(hermesDir, "plans"), { recursive: true });
    const instance = await HermesAgentDriver.create({
      instanceId: "hermes-auth-pool",
      displayName: undefined,
      environment: { FAKE_ACP_AUTH_IDS: "openai-codex,hermes-setup:terminal" },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    const snap = await instance.snapshot();
    expect(snap).toMatchObject({ state: "available", authenticated: true });
    expect(snap.reason).toBeUndefined();
    await instance.dispose();
  });

  it("a pool change that never touches disk un-greys immediately — the cache hint asks `hermes auth list`, not a file", async () => {
    // the Bitwarden field shape: credentials hydrate into the process env,
    // ~/.hermes stays plans/-only forever. A `hermes auth add` there changes
    // NOTHING on disk, so a file-stat hint would serve the stale signed-out
    // probe for the rest of the 60s TTL. The hint asks the CLI's own pool
    // listing instead. FAKE_ACP_AUTH_IDS rides process.env (not the pinned
    // instance environment) so the test can flip the pool mid-instance the
    // way the real pool changes out from under a running server.
    const hermesDir = join(homedir(), ".hermes");
    rmSync(hermesDir, { recursive: true, force: true });
    mkdirSync(join(hermesDir, "plans"), { recursive: true });
    const instance = await HermesAgentDriver.create({
      instanceId: "hermes-diskless-pool",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    const prev = process.env.FAKE_ACP_AUTH_IDS;
    try {
      process.env.FAKE_ACP_AUTH_IDS = SETUP_ONLY_AUTH_IDS;
      const before = await instance.snapshot();
      expect(before).toMatchObject({ state: "available", authenticated: false });
      expect(before.reason).toContain("hermes auth");
      expect(before.reason).not.toContain("hermes login");

      process.env.FAKE_ACP_AUTH_IDS = POOL_AUTH_IDS; // `hermes auth add openai-codex`, Bitwarden-side
      const after = await instance.snapshot();
      expect(after).toMatchObject({ state: "available", authenticated: true });
      expect(after.reason).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.FAKE_ACP_AUTH_IDS;
      else process.env.FAKE_ACP_AUTH_IDS = prev;
      await instance.dispose();
    }
  });

  it("only the terminal setup method advertised → available with the `hermes auth` hint, never `hermes login`", async () => {
    // credential-less but ACP-capable: still available (models stay
    // selectable) and the picker gets the honest hint instead of a silent
    // healthy look. hermes-setup is advertised even with zero credentials,
    // and a terminal-typed method must never read as signed-in.
    const instance = await HermesAgentDriver.create({
      instanceId: "hermes-auth-none",
      displayName: undefined,
      environment: { FAKE_ACP_AUTH_IDS: "hermes-setup:terminal" },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    const snap = await instance.snapshot();
    expect(snap).toMatchObject({ state: "available", authenticated: false });
    expect(snap.reason).toContain("hermes auth");
    expect(snap.reason).toContain("hermes setup");
    expect(snap.reason).not.toContain("hermes login");
    await instance.dispose();
  });
});
