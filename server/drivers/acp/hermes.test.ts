// Hermes driver contract tests, run against the scripted fake ACP CLI in
// server/testing/fake-acp-cli.ts (FAKE_ACP_AUTH_IDS=chatgpt-oauth). Mirrors
// acp.test.ts for the shared runtime, plus the Hermes-specific quirks:
// approval-policy always pinned on argv, OPENAI_API_KEY stripped from the
// child env, chatgpt-oauth-only auth that fails closed BOTH ways (method not
// advertised / authenticate errors), and the expired-token shape (auth ok,
// session/prompt -32000) settling as auth_required instead of hanging.
//
// This suite runs on Windows too: the fake CLI is a `.ts` path, which
// resolveCliCommand always executes via process.execPath on every platform —
// no shebang, no chmodSync, no posixOnly.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureDirs, NATIVE_DIR } from "../../config.ts";
import type { ProviderInstance } from "../../contracts.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
import { HermesAgentDriver } from "./hermes.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "testing", "fake-acp-cli.ts");
// Strict-grammar hermes: rejects any argv that isn't exactly what hermes.ts
// emits (usage + exit 2, like a real CLI), then speaks ACP. The rc.12 field
// failure shipped because only accept-anything fakes ever saw the argv.
const STRICT_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "testing", "fake-hermes-cli.ts");

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

  it("is user-portable: bare PATH name by default, config.cli override, no baked-in install path", () => {
    // the default is a bare binary name resolved on PATH — never a directory
    const cli = HermesAgentDriver.decodeConfig({}).cli;
    expect(cli).toBe("hermes");
    expect(cli).not.toMatch(/[\\/]/);
    // a per-instance override points at a custom binary verbatim
    expect(HermesAgentDriver.decodeConfig({ cli: "/opt/custom/hermes" }).cli).toBe("/opt/custom/hermes");
    // and the driver source carries no developer-machine absolute paths;
    // the auth probe must stay homedir-relative (~/.hermes/auth.json)
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
        FAKE_ACP_AUTH_IDS: "chatgpt-oauth",
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
      "thread.token-usage.updated",
      "item.completed", // assistant_text (summed) on settle
      "turn.completed",
    ]);
    expect(recorder.events.every((e) => e.turnId === turnId && e.provider === "hermesAgent")).toBe(true);
    const text = recorder.events.find((e) => e.type === "item.completed" && (e as any).itemType === "assistant_text")!;
    expect((text as any).text).toBe("hello from fake acp");
    expect(recorder.events.at(-1)).toMatchObject({ type: "turn.completed", ok: true });
    expect(instance.adapter.hasSession("t-hermes-happy")).toBe(false);

    // native tee is labeled with the Hermes source, both directions
    const native = readFileSync(join(NATIVE_DIR, "t-hermes-happy.ndjson"), "utf8");
    expect(native).toContain('"source":"hermes.acp"');
    expect(native).toContain('"dir":"out"');
    expect(native).toContain('"dir":"in"');
  });

  it("pins --approval-policy acp, passes -m through, and strips key env vars", async () => {
    const dump = join(scratch, "dump.json");
    await create({ env: { FAKE_ACP_DUMP: dump } });
    process.env.OPENAI_API_KEY = "sk-should-not-leak";
    process.env.HERMES_API_KEY = "hermes-should-not-leak";

    await instance.adapter.sendTurn({ threadId: "t-hermes-argv", text: "go", model: "gpt-5.5" });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv).toEqual(["--approval-policy", "acp", "-m", "gpt-5.5", "acp", "stdio"]);
    expect(seen.env.OPENAI_API_KEY).toBeUndefined();
    expect(seen.env.HERMES_API_KEY).toBeUndefined();
    expect(JSON.stringify(seen)).not.toContain("should-not-leak");
  });

  it("pins --approval-policy never (still explicit) under fullAuto, no -m without a model", async () => {
    const dump = join(scratch, "dump.json");
    await create({ fullAuto: true, env: { FAKE_ACP_DUMP: dump } });

    await instance.adapter.sendTurn({ threadId: "t-hermes-auto", text: "go" });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv).toEqual(["--approval-policy", "never", "acp", "stdio"]);
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

  it("fails closed when chatgpt-oauth is not among the advertised methods", async () => {
    await create({ env: { FAKE_ACP_AUTH_IDS: "cached_token,api-key" } });
    await instance.adapter.sendTurn({ threadId: "t-hermes-noauth", text: "go" });
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: false, stopReason: "auth_required" });
    const err = recorder.events.find((e) => e.type === "runtime.error")!;
    expect(err.message).toMatch(/not signed in to ChatGPT/);
    expect(err.message).toMatch(/hermes login/);
  });

  it("fails closed when authenticate itself errors (dead login)", async () => {
    await create({ mode: "auth-error" });
    await instance.adapter.sendTurn({ threadId: "t-hermes-autherr", text: "go" });
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: false, stopReason: "auth_required" });
  });

  it("an expired token at session/prompt settles as auth_required — no hang", async () => {
    await create({ mode: "expired-token" });
    await instance.adapter.sendTurn({ threadId: "t-hermes-expired", text: "go" });
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: false, stopReason: "auth_required" });
    const err = recorder.events.find((e) => e.type === "runtime.error")!;
    expect(err.message).toMatch(/not signed in to ChatGPT/);
    expect(instance.adapter.hasSession("t-hermes-expired")).toBe(false);
  });

  it("a write to a closed child stdin settles the turn — never an unhandled EPIPE crash (rc.12)", async () => {
    // the fake replies to initialize but closes its stdin first, so the
    // driver's next write (authenticate) lands on a closed pipe. Without a
    // stdin 'error' listener that async EPIPE killed the whole server.
    await create({ mode: "stdin-close" });
    await instance.adapter.sendTurn({ threadId: "t-hermes-epipe", text: "go" });
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: false, stopReason: "stdin_error" });
    const err = recorder.events.find((e) => e.type === "runtime.error")!;
    expect(err.message).toContain("stdin write failed");
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

  const createStrict = async (opts: { fullAuto?: boolean; reject?: boolean } = {}) => {
    instance = await HermesAgentDriver.create({
      instanceId: "hermes-strict",
      displayName: "Hermes Strict",
      environment: {
        FAKE_ACP_AUTH_IDS: "chatgpt-oauth",
        ...(opts.reject ? { FAKE_HERMES_GRAMMAR: "reject" } : {}),
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

  it("a hermes that rejects the argv (the field binary) fails the turn loudly, never silently", async () => {
    await createStrict({ reject: true });
    await instance.adapter.sendTurn({ threadId: "t-strict-reject", text: "hi", model: "gpt-5.6-sol" });
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: false, stopReason: "exit_before_result" });
    expect(recorder.events.some((e) => e.type === "turn.completed" && (e as any).ok)).toBe(false);
    const err = recorder.events.find((e) => e.type === "runtime.error")!;
    expect(err.message).toContain("exited 2");
    expect(err.message).toContain("orchestrator"); // the CLI's own usage catalog, surfaced
  });

  it("one-shot generateText uses the accepted `exec -p` grammar", async () => {
    await createStrict();
    expect(await instance.generateText!("distill")).toBe("fake hermes one-shot");
  });

  it("snapshot verifies protocol identity: the field binary is unavailable with path + version", async () => {
    await createStrict({ reject: true });
    const snap = await instance.snapshot();
    expect(snap.state).toBe("unavailable");
    expect(snap.reason).toContain("does not speak ACP");
    expect(snap.reason).toContain("fake-hermes 0.9.0"); // --version alone no longer means available
    expect(snap.reason).toContain("fake-hermes-cli"); // resolved path — which binary is this?
  });

  it("snapshot stays available when the binary accepts the argv and speaks ACP", async () => {
    await createStrict();
    expect(await instance.snapshot()).toMatchObject({ state: "available", version: "fake-hermes 0.9.0" });
  });
});

describe("Hermes generateText (one-shot exec)", () => {
  it("runs `hermes exec -p` and returns trimmed text without leaking keys", async () => {
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
      const text = await instance.generateText!("distill this");
      expect(text).toBe("User prefers concise replies. Last turn noted.");
      const seen = JSON.parse(readFileSync(dump, "utf8"));
      expect(seen.execArgv).toEqual(["exec", "-p", "distill this"]);
      expect(seen.env.OPENAI_API_KEY).toBeUndefined();
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

  it("authenticated tracks the ~/.hermes/auth.json login file", async () => {
    const instance = await HermesAgentDriver.create({
      instanceId: "hermes-auth-file",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    // HOME is the per-suite sandbox (testing/setup.ts) — never the real one
    const authFile = join(homedir(), ".hermes", "auth.json");
    rmSync(authFile, { force: true });
    expect((await instance.snapshot())).toMatchObject({ state: "available", authenticated: false });
    mkdirSync(dirname(authFile), { recursive: true });
    writeFileSync(authFile, JSON.stringify({ tokens: "fake" }));
    expect((await instance.snapshot())).toMatchObject({ state: "available", authenticated: true });
    rmSync(authFile, { force: true });
    await instance.dispose();
  });
});
