// Gemini driver contract tests, run against the scripted fake ACP CLI in
// server/testing/fake-acp-cli.ts and the strict-grammar fake-gemini-cli.ts
// shaped like a live gemini-cli 0.55.1 (probed 2026-08-16). Mirrors
// acp.test.ts for the shared runtime, plus the Gemini-specific quirks:
// the current spawn grammar (`--acp --approval-mode default [-m <model>]` —
// never the deprecated `--experimental-acp`, never `--yolo` — P0.1), NO
// authenticate call ever (gemini's authenticate RPC persists the method
// into the user's settings.json and clears the cached OAuth creds on a
// method switch — a turn must not rewrite the user's login), the signed-out
// shape (auth methods advertised unconditionally, session/new fails -32000)
// settling as auth_required with copy that names the REAL sign-in paths
// (run `gemini` / GEMINI_API_KEY — there is no `gemini login` command), the
// selectedType-aware sign-in heuristic, and the model catalog riding the
// CLI's own session/new advertisement instead of an unchecked constant.
//
// This suite runs on Windows too: the fakes are `.ts` paths, which
// resolveCliCommand always executes via process.execPath on every platform —
// no shebang, no chmodSync, no posixOnly.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureDirs, NATIVE_DIR } from "../../config.ts";
import type { ProviderInstance } from "../../contracts.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
import { probeProtocol } from "../cli.ts";
import { GEMINI_AUTH_METHOD_IDS, GeminiAgentDriver } from "./gemini.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "testing", "fake-acp-cli.ts");
// Strict-grammar gemini, shaped like the live binary (0.55.1): rejects any
// argv that isn't exactly what gemini.ts emits (Unknown argument + exit 1,
// like the real yargs CLI — including the deprecated `--experimental-acp`
// this driver used to spawn), then speaks ACP with the real auth-method ids
// and the real session/new model catalog.
const STRICT_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "testing", "fake-gemini-cli.ts");
// What a live gemini-cli 0.55.1 advertised in session/new's
// models.availableModels on 2026-08-16 — the dated source of the driver's
// fallback catalog, also advertised verbatim by the strict fake.
const ADVERTISED_MODELS = [
  "auto",
  "gemini-3.1-pro-preview-customtools",
  "gemini-3-flash-preview",
  "gemini-2.5-pro",
  "gemini-3.5-flash",
  "gemini-3.1-flash-lite",
];

const geminiDir = () => join(homedir(), ".gemini");
const writeSettings = (selectedType: string) => {
  mkdirSync(geminiDir(), { recursive: true });
  writeFileSync(join(geminiDir(), "settings.json"), JSON.stringify({ security: { auth: { selectedType } } }));
};

describe("Gemini decodeConfig & model catalog", () => {
  it("defaults to the gemini binary", () => {
    expect(GeminiAgentDriver.decodeConfig({})).toEqual({ cli: "gemini", fullAuto: false, workspace: undefined });
    expect(GeminiAgentDriver.decodeConfig(undefined)).toEqual({ cli: "gemini", fullAuto: false, workspace: undefined });
  });

  it("fullAuto only when explicitly true", () => {
    expect(GeminiAgentDriver.decodeConfig({ fullAuto: "yes" }).fullAuto).toBe(false);
    expect(GeminiAgentDriver.decodeConfig({ fullAuto: true }).fullAuto).toBe(true);
  });

  it("describe()/snapshot() replaces create-time constants with session/new availableModels", async () => {
    const inst = await GeminiAgentDriver.create({
      instanceId: "gemini-catalog",
      displayName: "Gemini",
      environment: {
        FAKE_ACP_AUTH_IDS: "oauth-personal,gemini-api-key,vertex-ai,gateway",
        FAKE_ACP_SESSION_MODELS: "gemini-9-preview,auto",
      },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    expect(inst.models.options.map((o) => o.id)).toEqual(ADVERTISED_MODELS);
    await inst.snapshot();
    expect(inst.models.options.map((o) => o.id)).toEqual(["gemini-9-preview", "auto"]);
    expect(inst.models.default).toBe("gemini-9-preview");
    await inst.dispose();
  });

  it("catalogs the ids a live gemini-cli 0.55.1 advertised (2026-08-16), defaulting to the CLI's own `auto`", () => {
    // the catalog is the CLI's session/new advertisement, dated — not an
    // invented list. `auto` is what currentModelId reports with no -m.
    expect(GeminiAgentDriver.models.default).toBe("auto");
    expect(GeminiAgentDriver.models.options.map((o) => o.id)).toEqual(ADVERTISED_MODELS);
    // the pre-refresh stale hardcode: gemini-2.5-flash is no longer
    // advertised by the CLI and must not come back as a phantom option
    expect(GeminiAgentDriver.models.options.map((o) => o.id)).not.toContain("gemini-2.5-flash");
  });

  it("is user-portable: bare PATH name by default, config.cli override, no baked-in install path", () => {
    const cli = GeminiAgentDriver.decodeConfig({}).cli;
    expect(cli).toBe("gemini");
    expect(cli).not.toMatch(/[\\/]/);
    expect(GeminiAgentDriver.decodeConfig({ cli: "/opt/custom/gemini" }).cli).toBe("/opt/custom/gemini");
    // the driver source carries no developer-machine absolute paths; the
    // auth heuristic must stay homedir-relative (~/.gemini)
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "gemini.ts"), "utf8");
    expect(source).not.toMatch(/[A-Za-z]:\\/);
    expect(source).not.toMatch(/(\/Users\/|\/home\/|\\Users\\)/);
    expect(source).toContain("homedir()");
    expect(source).toContain('".gemini"');
  });
});

describe("Gemini turns (fake CLI)", () => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;
  let scratch: string;

  const create = async (opts: { mode?: string; fullAuto?: boolean; env?: Record<string, string> } = {}) => {
    instance = await GeminiAgentDriver.create({
      instanceId: "gemini-test",
      displayName: "Gemini Test",
      environment: {
        // the real 0.55.1 shape: every method advertised, signed in or not
        FAKE_ACP_AUTH_IDS: "oauth-personal,gemini-api-key,vertex-ai,gateway",
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
    scratch = mkdtempSync(join(tmpdir(), "omb-gemini-test-"));
  });

  afterEach(async () => {
    delete process.env.GEMINI_API_KEY;
    recorder?.stop();
    await instance?.dispose();
    rmSync(scratch, { recursive: true, force: true });
    rmSync(geminiDir(), { recursive: true, force: true });
  });

  it("normalizes a full turn into the canonical event sequence and tees gemini.acp", async () => {
    await create();
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-gemini-happy", text: "hi", model: "auto" });
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
    expect(recorder.events.every((e) => e.turnId === turnId && e.provider === "geminiAgent")).toBe(true);
    const text = recorder.events.find((e) => e.type === "item.completed" && (e as any).itemType === "assistant_text")!;
    expect((text as any).text).toBe("hello from fake acp");
    expect(recorder.events.at(-1)).toMatchObject({ type: "turn.completed", ok: true });
    expect(instance.adapter.hasSession("t-gemini-happy")).toBe(false);

    const native = readFileSync(join(NATIVE_DIR, "t-gemini-happy.ndjson"), "utf8");
    expect(native).toContain('"source":"gemini.acp"');
    expect(native).toContain('"dir":"out"');
    expect(native).toContain('"dir":"in"');
  });

  it("pins the 0.55.1 argv `--acp --approval-mode default -m <model>` and keeps GEMINI_API_KEY", async () => {
    const dump = join(scratch, "dump.json");
    await create({ env: { FAKE_ACP_DUMP: dump } });
    // the API key is a first-class Gemini auth path — never stripped
    // (unlike grok/hermes, where a key silently flips billing)
    process.env.GEMINI_API_KEY = "fake-gemini-key-canary";

    await instance.adapter.sendTurn({ threadId: "t-gemini-argv", text: "go", model: "gemini-3.5-flash" });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv).toEqual(["--acp", "--approval-mode", "default", "-m", "gemini-3.5-flash"]);
    // the deprecated flag this driver used to spawn must never come back
    expect(seen.argv).not.toContain("--experimental-acp");
    expect(seen.env.GEMINI_API_KEY).toBe("fake-gemini-key-canary");
    // headless turns must never pop a browser for a dead OAuth login
    expect(seen.env.NO_BROWSER).toBe("true");
  });

  it("fullAuto never reaches the argv — approval mode stays `default`, no --yolo (P0.1)", async () => {
    const dump = join(scratch, "dump.json");
    await create({ fullAuto: true, env: { FAKE_ACP_DUMP: dump } });

    await instance.adapter.sendTurn({ threadId: "t-gemini-auto", text: "go" });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    // fullAuto auto-allows at the ACP permission bridge (audited, per-ask)
    // — never via the CLI's --yolo / --approval-mode yolo bypass, which
    // would skip session/request_permission entirely
    expect(seen.argv).toEqual(["--acp", "--approval-mode", "default"]);
    expect(seen.argv).not.toContain("--yolo");
    expect(seen.argv).not.toContain("-y");
    expect(seen.argv).not.toContain("yolo");
  });

  it("never calls authenticate — gemini's authenticate RPC rewrites the user's settings and can clear their OAuth creds", async () => {
    // verified against 0.55.1: authenticate(methodId) persists
    // security.auth.selectedType into ~/.gemini/settings.json and calls
    // clearCachedCredentialFile() when the method changes. A driver that
    // authenticates with its own preference would delete a user's "Log in
    // with Google" session as a side effect of running a turn. session/new
    // authenticates off the user's own settings + env instead.
    const dump = join(scratch, "dump.json");
    await create({ env: { FAKE_ACP_DUMP: dump } });
    await instance.adapter.sendTurn({ threadId: "t-gemini-noauthcall", text: "go" });
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: true });
    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.authenticate).toBeUndefined();
  });

  it("proceeds through a CLI that advertises no auth methods at all (lenient login)", async () => {
    await create({ mode: "no-auth" });
    await instance.adapter.sendTurn({ threadId: "t-gemini-lenient", text: "go" });
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: true });
  });

  it("surfaces a permission ask via the broker and a DENY still completes the turn", async () => {
    await create({ mode: "permission" });
    await instance.adapter.sendTurn({ threadId: "t-gemini-deny", text: "go" });
    const opened = await recorder.until((e) => e.type === "request.opened");
    expect(opened).toMatchObject({ requestType: "permission", tool: "shell" });

    await instance.adapter.respondToRequest("t-gemini-deny", (opened as any).requestId, { behavior: "deny" });
    const resolved = await recorder.until((e) => e.type === "request.resolved");
    expect(resolved).toMatchObject({ behavior: "deny", source: "user" });
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: true });
  });

  it("session.started reports the model the CLI ADVERTISES on session/new, not the one we asked for", async () => {
    // gemini-cli carries no modelState in initialize; the session result's
    // models.currentModelId is the CLI's own truth. Surfacing it is the
    // anti-silent-failover path: if the CLI resolves a different model than
    // requested, the event says so.
    await create({ env: { FAKE_ACP_SESSION_MODELS: "gemini-9-preview,auto" } });
    await instance.adapter.sendTurn({ threadId: "t-gemini-advmodel", text: "go", model: "gemini-3.5-flash" });
    const started = await recorder.until((e) => e.type === "session.started");
    expect((started as any).model).toBe("gemini-9-preview");
    await recorder.until((e) => e.type === "turn.completed");
  });

  it("an expired login at session/prompt settles as auth_required with the real sign-in copy", async () => {
    await create({ mode: "expired-token" });
    await instance.adapter.sendTurn({ threadId: "t-gemini-expired", text: "go" });
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: false, stopReason: "auth_required" });
    const err = recorder.events.find((e) => e.type === "runtime.error")!;
    expect(err.message).toContain("GEMINI_API_KEY");
    expect(err.message).not.toMatch(/gemini login/);
    expect(instance.adapter.hasSession("t-gemini-expired")).toBe(false);
  });

  it("a write to a closed child stdin settles the turn — never an unhandled EPIPE crash", async () => {
    await create({ mode: "stdin-close" });
    await instance.adapter.sendTurn({ threadId: "t-gemini-epipe", text: "go" });
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: false, stopReason: "stdin_error" });
    expect(instance.adapter.hasSession("t-gemini-epipe")).toBe(false);
  });

  it("interrupt settles a hung turn", async () => {
    await create({ mode: "hang" });
    await instance.adapter.sendTurn({ threadId: "t-gemini-int", text: "go" });
    await recorder.until((e) => e.type === "session.started");
    await instance.adapter.interruptTurn("t-gemini-int");
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ type: "turn.completed" });
    expect(instance.adapter.hasSession("t-gemini-int")).toBe(false);
  });

  it("mounts mcpServers on session/new AND session/load without secrets in argv", async () => {
    const dump = join(scratch, "dump.json");
    await create({ env: { FAKE_ACP_DUMP: dump } });
    const composioKey = "ck_gemini_secret";
    const memoryToken = "mem_gemini_secret";
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

    await instance.adapter.sendTurn({ threadId: "t-gemini-mcp-new", text: "go", integrations });
    await recorder.until((e) => e.type === "turn.completed" && e.threadId === "t-gemini-mcp-new");
    const started = JSON.parse(readFileSync(dump, "utf8"));
    const newNames = (started.sessionNew?.mcpServers ?? []).map((s: { name: string }) => s.name);
    expect(newNames).toEqual(expect.arrayContaining(["composio", "memory"]));
    expect(JSON.stringify(started.argv)).not.toContain(composioKey);
    expect(JSON.stringify(started.argv)).not.toContain(memoryToken);

    await instance.adapter.sendTurn({
      threadId: "t-gemini-mcp-load",
      text: "again",
      resumeCursor: "fake-acp-session",
      integrations,
    });
    await recorder.until((e) => e.type === "turn.completed" && e.threadId === "t-gemini-mcp-load");
    const resumed = JSON.parse(readFileSync(dump, "utf8"));
    const loadNames = (resumed.sessionLoad?.mcpServers ?? []).map((s: { name: string }) => s.name);
    expect(loadNames).toEqual(expect.arrayContaining(["composio", "memory"]));
    expect(JSON.stringify(resumed.argv)).not.toContain(composioKey);
    expect(JSON.stringify(resumed.argv)).not.toContain(memoryToken);
  });
});

describe("Gemini spawn grammar (strict fake CLI)", () => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;

  const createStrict = async (opts: { fullAuto?: boolean; env?: Record<string, string> } = {}) => {
    instance = await GeminiAgentDriver.create({
      instanceId: "gemini-strict",
      displayName: "Gemini Strict",
      environment: { ...opts.env },
      enabled: true,
      config: { cli: STRICT_CLI, fullAuto: opts.fullAuto === true },
    });
    recorder = recordEvents(instance.adapter);
  };

  afterEach(async () => {
    recorder?.stop();
    await instance?.dispose();
    rmSync(geminiDir(), { recursive: true, force: true });
  });

  it("the exact argv the driver emits (with -m) is accepted and completes a turn", async () => {
    await createStrict();
    await instance.adapter.sendTurn({ threadId: "t-gstrict-model", text: "hi", model: "gemini-3.5-flash" });
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: true, stopReason: null });
  });

  it("the fullAuto / no-model argv is accepted too and reports the CLI's own default model (`auto`)", async () => {
    await createStrict({ fullAuto: true });
    await instance.adapter.sendTurn({ threadId: "t-gstrict-auto", text: "hi" });
    const started = await recorder.until((e) => e.type === "session.started");
    // no -m → the CLI resolves "auto", and the event reports THE CLI'S
    // resolution — the catalog constant has a live refresh path per turn
    expect((started as any).model).toBe("auto");
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: true, stopReason: null });
  });

  it("the OLD argv (--experimental-acp) is rejected by the 0.55.1-shaped fake: Unknown argument + exit 1", async () => {
    // pins WHY the driver moved to `--acp`: the strict fake models the
    // current CLI grammar, and the deprecated spawn this driver used to
    // emit is exactly what a future gemini-cli will reject
    const { code, stderr } = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [STRICT_CLI, "--experimental-acp"], {
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
      });
      let stderr = "";
      child.stderr.on("data", (c) => (stderr += c));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stderr }));
    });
    expect(code).toBe(1);
    expect(stderr).toContain("Unknown argument");
    expect(stderr).toContain("Usage: gemini");
  });

  it("a gemini that rejects the argv fails the turn loudly, never silently", async () => {
    await createStrict({ env: { FAKE_GEMINI_GRAMMAR: "reject" } });
    await instance.adapter.sendTurn({ threadId: "t-gstrict-reject", text: "hi", model: "auto" });
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: false, stopReason: "exit_before_result" });
    const err = recorder.events.find((e) => e.type === "runtime.error")!;
    expect(err.message).toContain("exited 1");
    expect(err.message).toContain("Unknown argument"); // the CLI's own usage, surfaced
  });

  it("signed out: session/new's -32000 settles as auth_required naming the REAL sign-in paths", async () => {
    // the live 0.55.1 signed-out shape: initialize advertises every auth
    // method, authenticate would even "succeed" — session/new is the gate.
    // The failure copy must name what actually exists (run `gemini`, the
    // /auth command, GEMINI_API_KEY) — there is no `gemini login` command.
    await createStrict({ env: { FAKE_GEMINI_AUTH: "signed-out" } });
    await instance.adapter.sendTurn({ threadId: "t-gstrict-signedout", text: "hi" });
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: false, stopReason: "auth_required" });
    const err = recorder.events.find((e) => e.type === "runtime.error")!;
    expect(err.message).toMatch(/run `gemini`/);
    expect(err.message).toContain("GEMINI_API_KEY");
    expect(err.message).not.toMatch(/gemini login/);
    expect(err.message).not.toMatch(/gemini auth/);
    expect(instance.adapter.hasSession("t-gstrict-signedout")).toBe(false);
  });

  it("snapshot on a binary that rejects the argv reports the real usage/exit — never a login hint", async () => {
    // an argv rejection is a CLI/argv fault whatever the credential state;
    // blaming login is the rc.14 Hermes field failure. The probe never
    // completed a handshake, and the heuristic still knows the sandbox has
    // no credentials — authenticated:false may show, but the REASON must be
    // the binary's own rejection, not sign-in copy.
    await createStrict({ env: { FAKE_GEMINI_GRAMMAR: "reject", GEMINI_API_KEY: "fake-key-canary" } });
    const snap = await instance.snapshot();
    expect(snap.state).toBe("unavailable");
    expect(snap.reason).toContain("does not speak ACP");
    expect(snap.reason).toContain("wrong or outdated CLI");
    expect(snap.reason).toContain("exited 1");
    expect(snap.reason).toContain("Unknown argument");
    expect(snap.reason).toContain("fake-gemini 0.55.1"); // --version alone no longer means available
    expect(snap.reason).toContain("fake-gemini-cli"); // resolved path — which binary is this?
    expect(snap.reason).not.toMatch(/not signed in/);
  });

  it("snapshot stays available + authenticated with an API key when the binary accepts the argv and speaks ACP", async () => {
    await createStrict({ env: { GEMINI_API_KEY: "fake-key-canary" } });
    expect(await instance.snapshot()).toMatchObject({
      state: "available",
      authenticated: true,
      version: "fake-gemini 0.55.1",
    });
  });

  it("signed-in truth is the CLI's own session gate — empty disk, no env key, session/new succeeds → authenticated", async () => {
    // Hermes-parallel: whatever is (not) on disk, the CLI's own answer
    // wins. The strict fake's session/new succeeds, so the snapshot must
    // report signed-in even though every file/env heuristic says otherwise.
    await createStrict();
    const snap = await instance.snapshot();
    expect(snap).toMatchObject({ state: "available", authenticated: true });
    expect(snap.reason).toBeUndefined();
  });

  it("signed-out truth beats a stale env key — session/new -32000 wins over GEMINI_API_KEY in the env", async () => {
    // the reverse direction: the heuristic would say signed-in (a key sits
    // in the env), but the CLI's session gate says no — the CLI is asked
    // first, the file/env heuristic is fallback only
    await createStrict({ env: { FAKE_GEMINI_AUTH: "signed-out", GEMINI_API_KEY: "fake-key-canary" } });
    const snap = await instance.snapshot();
    expect(snap).toMatchObject({ state: "available", authenticated: false });
    expect(snap.reason).toContain("GEMINI_API_KEY");
    expect(snap.reason).not.toMatch(/gemini login/);
  });

  it("one-shot generateText uses the accepted `-p` grammar", async () => {
    await createStrict();
    expect(await instance.generateText!("distill")).toBe("fake gemini one-shot");
  });
});

describe("Gemini snapshot & sign-in FALLBACK heuristic", () => {
  // The CLI-asked probe (session/new gate) is the primary signal — pinned
  // in the strict-fake suite above. This suite pins the fallback: the fake
  // fails session/new with a generic NON-auth error, so the probe is
  // inconclusive and the selectedType-keyed disk/env heuristic must decide.
  let instance: ProviderInstance | null = null;

  const create = async (env: Record<string, string> = {}) => {
    instance = await GeminiAgentDriver.create({
      instanceId: "gemini-snap",
      displayName: undefined,
      environment: { FAKE_ACP_MODE: "session-new-error", ...env },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    return instance;
  };

  afterEach(async () => {
    await instance?.dispose();
    instance = null;
    rmSync(geminiDir(), { recursive: true, force: true });
    rmSync(join(homedir(), ".env"), { force: true });
  });

  it("a missing binary is unavailable with a CLI-not-found reason", async () => {
    const inst = await GeminiAgentDriver.create({
      instanceId: "gemini-missing",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: { cli: "definitely-not-a-real-gemini-binary", fullAuto: false },
    });
    const snap = await inst.snapshot();
    expect(snap.state).toBe("unavailable");
    expect(snap.reason).toContain("CLI not found");
    await inst.dispose();
  });

  it("nothing configured → available but signed out, with the real sign-in hint (never `gemini login`)", async () => {
    // signed-out is a DEGRADE, not a grey-out: the CLI still speaks ACP,
    // models stay selectable, and the picker shows the honest hint
    const inst = await create();
    const snap = await inst.snapshot();
    expect(snap).toMatchObject({ state: "available", authenticated: false });
    expect(snap.reason).toMatch(/run `gemini`/);
    expect(snap.reason).toContain("GEMINI_API_KEY");
    expect(snap.reason).not.toMatch(/gemini login/);
  });

  it("oauth-personal selected: the cached Google login file is the signal, and a login un-greys immediately", async () => {
    writeSettings("oauth-personal");
    const inst = await create();
    const before = await inst.snapshot();
    expect(before).toMatchObject({ state: "available", authenticated: false });
    expect(before.reason).toContain("Log in with Google");

    // "Log in with Google" completed → oauth_creds.json appears; the
    // identity-cache key carries the auth hint, so the very next snapshot
    // re-probes instead of serving the stale signed-out state for 60s
    writeFileSync(
      join(geminiDir(), "oauth_creds.json"),
      JSON.stringify({ access_token: "fake-oauth-token-not-a-real-secret", token_type: "Bearer" }),
    );
    const after = await inst.snapshot();
    expect(after).toMatchObject({ state: "available", authenticated: true });
    expect(after.reason).toBeUndefined();
  });

  it("GEMINI_API_KEY in the environment is signed in, with or without settings", async () => {
    const inst = await create({ GEMINI_API_KEY: "fake-key-canary" });
    expect(await inst.snapshot()).toMatchObject({ state: "available", authenticated: true });
  });

  it("GOOGLE_API_KEY alone does NOT satisfy the api-key path (verified live: session/new still fails)", async () => {
    writeSettings("gemini-api-key");
    const inst = await create({ GOOGLE_API_KEY: "fake-vertex-express-key" });
    const snap = await inst.snapshot();
    expect(snap).toMatchObject({ state: "available", authenticated: false });
    expect(snap.reason).toContain("GEMINI_API_KEY");
  });

  it("vertex-ai selected: env credentials read as signed in, ADC setups as unknown — never a fabricated signed-out", async () => {
    writeSettings("vertex-ai");
    const inst = await create();
    const unknown = await inst.snapshot();
    expect(unknown.state).toBe("available");
    expect(unknown.authenticated).toBeUndefined(); // ADC is not probeable from one file
    expect(unknown.reason).toBeUndefined();
    await inst.dispose();
    instance = await create({ GOOGLE_API_KEY: "fake-vertex-express-key" });
    expect(await instance.snapshot()).toMatchObject({ state: "available", authenticated: true });
  });

  it("an ~/.env file makes a missing env key unknown, not signed out — the CLI loads keys from .env files", async () => {
    writeFileSync(join(homedir(), ".env"), "GEMINI_API_KEY=fake-dotenv-key\n");
    const inst = await create();
    const snap = await inst.snapshot();
    expect(snap.state).toBe("available");
    expect(snap.authenticated).toBeUndefined();
    expect(snap.reason).toBeUndefined();
  });

  it("the legacy flat selectedAuthType key still routes the heuristic", async () => {
    mkdirSync(geminiDir(), { recursive: true });
    writeFileSync(join(geminiDir(), "settings.json"), JSON.stringify({ selectedAuthType: "oauth-personal" }));
    const inst = await create({ GEMINI_API_KEY: "fake-key-canary" });
    // oauth selected (legacy schema) + no creds file: signed out even
    // though an unused API key sits in the env — session/new will ride the
    // SELECTED method, not the key
    const snap = await inst.snapshot();
    expect(snap).toMatchObject({ state: "available", authenticated: false });
  });
});

// ── live CLI conformance ─────────────────────────────────────────────────
// Runs only where a real `gemini` binary is installed (skipped in CI, which
// has none) — the backing for every "verified live" claim in gemini.ts.
// Local-only handshakes: initialize / session/new never call Google (a
// signed-out session/new fails before any network, and the suite's sandbox
// HOME carries no credentials), so default `pnpm test` stays offline.
const hasGeminiCli = (() => {
  try {
    const r = spawnSync(process.platform === "win32" ? "where" : "which", ["gemini"], {
      encoding: "utf8",
      timeout: 4000,
      windowsHide: true,
    });
    return r.status === 0 && Boolean(r.stdout.trim());
  } catch {
    return false;
  }
})();

describe.skipIf(!hasGeminiCli)("Gemini live CLI (skipped when `gemini` is not installed)", () => {
  const initMessage = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } },
  };

  it("speaks ACP on the exact spawn argv (with and without -m) and still accepts the deprecated flag", { timeout: 90_000 }, async () => {
    // the grammar gemini.ts actually emits…
    const bare = await probeProtocol("gemini", ["--acp", "--approval-mode", "default"], initMessage, {
      timeoutMs: 30_000,
    });
    expect(bare.ok).toBe(true);
    const withModel = await probeProtocol(
      "gemini",
      ["--acp", "--approval-mode", "default", "-m", "gemini-2.5-pro"],
      initMessage,
      { timeoutMs: 30_000 },
    );
    expect(withModel.ok).toBe(true);
    // …and the deprecated `--experimental-acp` the driver used to spawn is
    // (still) accepted by this version — documented, not relied upon
    const deprecated = await probeProtocol("gemini", ["--experimental-acp"], initMessage, { timeoutMs: 30_000 });
    expect(deprecated.ok).toBe(true);
  });

  it("advertises the pinned auth method ids in initialize.authMethods", { timeout: 60_000 }, async () => {
    // the ids gemini.ts documents are pinned against the LIVE CLI here —
    // if Google renames one, this fails instead of the driver guessing
    const probe = await probeProtocol("gemini", ["--acp", "--approval-mode", "default"], initMessage, {
      timeoutMs: 30_000,
    });
    expect(probe.ok).toBe(true);
    const init = probe.init as { protocolVersion?: number; authMethods?: Array<{ id?: string }> } | undefined;
    expect(init?.protocolVersion).toBe(1);
    const ids = (init?.authMethods ?? []).map((m) => m.id);
    for (const pinned of ["oauth-personal", "gemini-api-key", "vertex-ai"]) {
      expect(ids).toContain(pinned);
    }
    // the full advertised set should stay a superset of what we pinned;
    // NEW ids are fine (gateway arrived this way), renames are not
    expect(ids).toEqual(expect.arrayContaining([...GEMINI_AUTH_METHOD_IDS.filter((id) => id !== "gateway")]));
  });

  it("driver snapshot against the real binary degrades honestly — never a grey-out lie", { timeout: 90_000 }, async () => {
    const inst = await GeminiAgentDriver.create({
      instanceId: "gemini-live",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: { cli: "gemini", fullAuto: false },
    });
    try {
      const snap = await inst.snapshot();
      // a real gemini speaks ACP on our argv whatever its login state
      expect(snap.state).toBe("available");
      expect(snap.version).toBeTruthy();
      if (snap.authenticated === false) {
        // signed out (the suite's sandbox HOME has no credentials): the
        // hint names the real sign-in paths, never an invented command
        expect(snap.reason).toContain("GEMINI_API_KEY");
        expect(snap.reason).not.toMatch(/gemini login/);
      } else {
        // signed in via ambient env (e.g. GEMINI_API_KEY on the dev
        // machine) or inconclusive — either way, no login nag
        expect(snap.reason).toBeUndefined();
      }
    } finally {
      await inst.dispose();
    }
  });
});
