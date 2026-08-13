// Codex driver contract tests, run against the scripted fake app-server
// in server/testing/fake-codex-app-server.ts — the driver must drive the
// JSON-RPC handshake, normalize notifications into canonical events, and
// surface server->client approval requests as request.opened.
//
// Spawn-based tests are POSIX-only until Windows CLI spawning lands (the
// fake is a shebang script — same constraint as codex.cmd itself).
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ProviderInstance } from "../contracts.ts";
import { DATA_DIR } from "../config.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import { FALLBACK_CODEX_MODELS } from "./codex-models.ts";
import {
  CodexDriver,
  CODEX_ELICITATION_METHOD,
  CODEX_MCP_ELICITATION_FEATURE,
  codexElicitationCard,
  isCodexElicitationMethod,
  isCodexPermissionUserInput,
  isCodexPermissionsMethod,
  isCodexUserInputMethod,
} from "./codex.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-codex-app-server.ts");
const posixOnly = describe.skipIf(process.platform === "win32");

describe("CodexDriver.decodeConfig", () => {
  it("defaults to the codex binary with fullAuto off", () => {
    expect(CodexDriver.decodeConfig({})).toEqual({ cli: "codex", fullAuto: false });
    expect(CodexDriver.decodeConfig(undefined)).toEqual({ cli: "codex", fullAuto: false });
    expect(CodexDriver.decodeConfig({ fullAuto: true }).fullAuto).toBe(true);
    // anything non-true is off — a truthy string must not enable full auto
    expect(CodexDriver.decodeConfig({ fullAuto: "yes" }).fullAuto).toBe(false);
  });
});

describe("Codex requestUserInput classification", () => {
  it("treats item/tool/requestUserInput as the conversational user-input method", () => {
    expect(isCodexUserInputMethod("item/tool/requestUserInput")).toBe(true);
    expect(isCodexUserInputMethod("tool/requestUserInput")).toBe(true);
    expect(isCodexUserInputMethod("execCommandApproval")).toBe(false);
    expect(isCodexUserInputMethod("item/fileChange/requestApproval")).toBe(false);
    expect(isCodexUserInputMethod("mcpServer/elicitation/request")).toBe(false);
    expect(CODEX_ELICITATION_METHOD).toBe("mcpServer/elicitation/request");
    expect(CODEX_MCP_ELICITATION_FEATURE).toBe("tool_call_mcp_elicitation");
    expect(isCodexElicitationMethod("mcpServer/elicitation/request")).toBe(true);
    expect(isCodexElicitationMethod(CODEX_ELICITATION_METHOD)).toBe(true);
    expect(isCodexElicitationMethod("item/tool/requestUserInput")).toBe(false);
    expect(isCodexPermissionsMethod("item/permissions/requestApproval")).toBe(true);
    expect(isCodexPermissionsMethod("mcpServer/elicitation/request")).toBe(false);
  });

  it("does not treat A/B/C what-next questions as permission asks", () => {
    expect(
      isCodexPermissionUserInput({
        questions: [
          {
            id: "next",
            question: "What would you like to do?",
            options: [
              { label: "Create a Chief of Staff" },
              { label: "Explore the workspace" },
              { label: "Something else" },
            ],
          },
        ],
      }),
    ).toBe(false);
    expect(isCodexPermissionUserInput({ questions: [{ id: "q", question: "Free form?" }] })).toBe(false);
  });

  it("cards MCP elicitation with the server/tool name, not shell", () => {
    expect(
      codexElicitationCard({
        serverName: "agents",
        message: 'Allow the agents MCP server to run tool "list_bots"?',
        _meta: { codex_approval_kind: "mcp_tool_call" },
      }),
    ).toEqual({
      tool: "list_bots",
      summary: 'Allow the agents MCP server to run tool "list_bots"?',
    });
    expect(codexElicitationCard({ serverName: "memory", message: "Allow recall?" })).toEqual({
      tool: "memory",
      summary: "Allow recall?",
    });
    expect(codexElicitationCard({ serverName: "agents", _meta: { tool_title: "list_bots" } })).toEqual({
      tool: "list_bots",
      summary: "agents list_bots",
    });
  });

  it("still treats Accept/Decline/Cancel user-input as a permission ask", () => {
    expect(
      isCodexPermissionUserInput({
        questions: [
          {
            id: "mcp_approve",
            options: [{ label: "Accept" }, { label: "Decline" }, { label: "Cancel" }],
          },
        ],
      }),
    ).toBe(true);
  });
});

posixOnly("CodexDriver model catalog (fake CLI dump)", () => {
  let instance: ProviderInstance;
  let scratch: string;

  beforeEach(() => {
    chmodSync(FAKE_CLI, 0o755);
    scratch = mkdtempSync(join(tmpdir(), "omb-codex-catalog-"));
  });

  afterEach(async () => {
    delete process.env.FAKE_CODEX_MODE;
    delete process.env.FAKE_CODEX_DUMP;
    await instance?.dispose();
    rmSync(scratch, { recursive: true, force: true });
  });

  it("flows the fake CLI debug-models dump into picker options", async () => {
    const dump = join(scratch, "dump.json");
    process.env.FAKE_CODEX_DUMP = dump;
    instance = await CodexDriver.create({
      instanceId: "codex-catalog",
      displayName: "Codex Catalog",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv.slice(0, 2)).toEqual(["debug", "models"]);
    expect(seen.argv).toContain("--bundled");
    const ids = instance.models.options.map((o) => o.id);
    expect(ids).not.toEqual(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.4"]);
    expect(ids).toEqual(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4", "gpt-5.4-mini"]);
    expect(instance.models.options.find((o) => o.id === "gpt-5.6-luna")?.label).toBe("GPT-5.6 Luna");
    expect(ids).not.toContain("codex-auto-review");
    expect(instance.models.default).toBe("gpt-5.6-sol");
  });

  it("falls back to the static catalog when debug models fails", async () => {
    process.env.FAKE_CODEX_MODE = "no-models";
    instance = await CodexDriver.create({
      instanceId: "codex-catalog-fallback",
      displayName: "Codex Catalog",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    expect(instance.models).toEqual(FALLBACK_CODEX_MODELS);
    expect(instance.models.options.map((o) => o.id)).not.toEqual(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.4"]);
    expect(instance.models.options.some((o) => o.id === "gpt-5.6-luna")).toBe(true);
  });
});

posixOnly("CodexDriver turns (fake app-server)", () => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;
  let scratch: string;

  const create = async (opts: { mode?: string; fullAuto?: boolean } = {}) => {
    if (opts.mode) process.env.FAKE_CODEX_MODE = opts.mode;
    instance = await CodexDriver.create({
      instanceId: "codex-test",
      displayName: "Codex Test",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: opts.fullAuto ?? false },
    });
    recorder = recordEvents(instance.adapter);
  };

  beforeEach(() => {
    chmodSync(FAKE_CLI, 0o755);
    scratch = mkdtempSync(join(tmpdir(), "omb-codex-test-"));
  });

  afterEach(async () => {
    delete process.env.FAKE_CODEX_MODE;
    delete process.env.FAKE_CODEX_DUMP;
    delete process.env.OPENAI_API_KEY;
    recorder?.stop();
    await instance?.dispose();
    rmSync(scratch, { recursive: true, force: true });
  });

  it("runs the handshake and normalizes a full turn", async () => {
    await create();
    const dump = join(scratch, "dump.json");
    process.env.FAKE_CODEX_DUMP = dump;
    process.env.OPENAI_API_KEY = "sk-should-not-leak";

    const { turnId } = await instance.adapter.sendTurn({
      threadId: "t-happy",
      text: "list files",
      system: "You are Testy.",
    });
    await recorder.until((e) => e.type === "turn.completed");

    const types = recorder.events.map((e) => e.type);
    expect(types).toEqual([
      "turn.started",
      "session.started",
      "item.started", // commandExecution ls -la
      "item.completed", // commandExecution done
      "content.delta",
      "item.completed", // assistant_text
      "thread.token-usage.updated",
      "turn.completed",
    ]);
    expect(recorder.events.every((e) => e.turnId === turnId && e.provider === "codex")).toBe(true);
    expect(recorder.events.find((e) => e.type === "session.started")).toMatchObject({
      sessionId: "codex-thread-1",
      model: "fake-codex-model",
    });
    expect(recorder.events.find((e) => e.type === "thread.token-usage.updated")).toMatchObject({
      input: 7,
      output: 3,
    });
    expect(recorder.events.at(-1)).toMatchObject({ type: "turn.completed", ok: true });

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.env.OPENAI_API_KEY).toBeUndefined();
    const methods = seen.calls.map((c: { method: string }) => c.method);
    expect(methods).toEqual(["initialize", "initialized", "thread/start", "turn/start"]);
    // persona is developerInstructions on thread/start — not prepended onto the user text
    const threadStart = seen.calls.find((c: { method: string }) => c.method === "thread/start");
    expect(threadStart.params.developerInstructions).toBe("You are Testy.");
    const turnStart = seen.calls.at(-1);
    expect(turnStart.params.input[0].text).toBe("list files");
    expect(turnStart.params.input[0].text).not.toContain("You are Testy.");
    // no integrations → no mcp overlay on thread/start
    expect(seen.threadStartConfig).toBeNull();
    expect(seen.threadResumeConfig).toBeNull();
    expect(seen.cwd).toBe(join(DATA_DIR, "workspaces", "codex"));
    expect(seen.cwd).not.toBe(homedir());
    expect(threadStart.params.cwd).toBe(seen.cwd);
  });

  it("runs the CLI in the per-bot workspace, not the home directory", async () => {
    await create();
    const dump = join(scratch, "dump.json");
    const workspace = join(scratch, "bot-ws");
    mkdirSync(workspace);
    process.env.FAKE_CODEX_DUMP = dump;
    await instance.adapter.sendTurn({ threadId: "t-cwd", text: "pwd", cwd: workspace });
    await recorder.until((e) => e.type === "turn.completed");
    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.cwd).toBe(workspace);
    const threadStart = seen.calls.find((c: { method: string }) => c.method === "thread/start");
    expect(threadStart.params.cwd).toBe(workspace);
    expect(threadStart.params.sandbox).toBe("workspace-write");
    expect(seen.cwd).not.toBe(homedir());
  });

  it("puts image bytes on turn/start input, not argv", async () => {
    await create();
    const dump = join(scratch, "dump.json");
    const img = join(scratch, "shot.png");
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    writeFileSync(img, png);
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(join(DATA_DIR, "config.json"), JSON.stringify({ github: { token: "ghp_secret_token" } }));
    process.env.FAKE_CODEX_DUMP = dump;

    await instance.adapter.sendTurn({
      threadId: "t-image",
      text: "look",
      attachments: [{ path: img, mime: "image/png" }, { path: join(DATA_DIR, "config.json") }],
    });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    const turnStart = seen.calls.find((c: { method: string }) => c.method === "turn/start");
    expect(turnStart.params.input[0]).toEqual({ type: "text", text: "look" });
    expect(turnStart.params.input[1]).toEqual({ type: "image", url: `data:image/png;base64,${png.toString("base64")}` });
    expect(JSON.stringify(seen.argv)).not.toContain(png.toString("base64"));
    expect(JSON.stringify(seen)).not.toContain("ghp_secret_token");
  });

  it("streams agentMessage deltas without re-emitting the settled text", async () => {
    process.env.FAKE_CODEX_MODE = "stream";
    await create();
    await instance.adapter.sendTurn({ threadId: "t-stream", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");

    const text = recorder.events.filter(
      (e: any) => e.type === "content.delta" && e.streamKind === "assistant_text",
    );
    // the two streamed chunks only — no third whole-message fallback delta
    expect(text.map((d: any) => d.delta)).toEqual(["done from ", "fake codex"]);
    const settled = recorder.events.filter(
      (e: any) => e.type === "item.completed" && e.itemType === "assistant_text",
    );
    expect(settled).toHaveLength(1);
    expect((settled[0] as any).text).toBe("done from fake codex");
  });

  it("tries thread/resume with a cursor and reuses the thread id", async () => {
    await create({ mode: "resume" });
    const dump = join(scratch, "dump.json");
    process.env.FAKE_CODEX_DUMP = dump;

    await instance.adapter.sendTurn({ threadId: "t-resume", text: "again", system: "You are Testy.", resumeCursor: "codex-thread-9" });
    const started = await recorder.until((e) => e.type === "session.started");
    expect(started).toMatchObject({ sessionId: "codex-thread-9" });
    await recorder.until((e) => e.type === "turn.completed");

    const dumped = JSON.parse(readFileSync(dump, "utf8"));
    const methods = dumped.calls.map((c: { method: string }) => c.method);
    expect(methods).toContain("thread/resume");
    expect(methods).not.toContain("thread/start");
    const resumed = dumped.calls.find((c: { method: string }) => c.method === "thread/resume");
    expect(resumed.params.developerInstructions).toBe("You are Testy.");
    const turnStart = dumped.calls.find((c: { method: string }) => c.method === "turn/start");
    expect(turnStart.params.input[0].text).toBe("again");
    // no integrations → resume must not invent an mcp overlay
    expect(dumped.threadResumeConfig).toBeNull();
  });

  it("falls back to a fresh thread when resume fails", async () => {
    await create(); // fake rejects thread/resume outside resume mode
    await instance.adapter.sendTurn({ threadId: "t-fallback", text: "go", resumeCursor: "gone-thread" });
    const started = await recorder.until((e) => e.type === "session.started");
    expect(started).toMatchObject({ sessionId: "codex-thread-1" });
    await recorder.until((e) => e.type === "turn.completed");
  });

  it("surfaces an approval request and forwards the user's decision", async () => {
    await create({ mode: "approval" });
    const dump = join(scratch, "dump.json");
    process.env.FAKE_CODEX_DUMP = dump;

    await instance.adapter.sendTurn({ threadId: "t-approve", text: "clean up" });
    const opened = await recorder.until((e) => e.type === "request.opened");
    expect(opened).toMatchObject({ requestType: "permission", tool: "shell", summary: "rm -rf scratch" });

    await instance.adapter.respondToRequest("t-approve", opened.requestId!, { behavior: "allow" });
    const resolved = await recorder.until((e) => e.type === "request.resolved");
    expect(resolved).toMatchObject({ behavior: "allow", source: "user" });

    await recorder.until((e) => e.type === "turn.completed");
    // legacy method name → legacy decision vocabulary
    expect(JSON.parse(readFileSync(dump, "utf8")).decision).toEqual({ decision: "approved" });
  });

  it("auto-approves commands in fullAuto without opening a request", async () => {
    await create({ mode: "approval", fullAuto: true });
    const dump = join(scratch, "dump.json");
    process.env.FAKE_CODEX_DUMP = dump;

    await instance.adapter.sendTurn({ threadId: "t-auto", text: "clean up" });
    await recorder.until((e) => e.type === "turn.completed");

    expect(recorder.events.some((e) => e.type === "request.opened")).toBe(false);
    expect(JSON.parse(readFileSync(dump, "utf8")).decision).toEqual({ decision: "approved" });
  });

  it("requireApproval forces a card even under fullAuto", async () => {
    await create({ mode: "approval", fullAuto: true });
    await instance.adapter.sendTurn({ threadId: "t-require", text: "clean up", requireApproval: true });
    const opened = await recorder.until((e) => e.type === "request.opened");
    expect(opened).toMatchObject({ requestType: "permission", tool: "shell" });
    await instance.adapter.respondToRequest("t-require", opened.requestId!, { behavior: "allow", source: "rule" });
    const resolved = await recorder.until((e) => e.type === "request.resolved");
    expect(resolved).toMatchObject({ behavior: "allow", source: "rule" });
    await recorder.until((e) => e.type === "turn.completed");
  });

  it("replies to MCP elicitation Allow with {action: accept}, not {decision}", async () => {
    await create({ mode: "elicitation" });
    const dump = join(scratch, "dump.json");
    process.env.FAKE_CODEX_DUMP = dump;

    await instance.adapter.sendTurn({ threadId: "t-elicit", text: "call list_bots exactly once" });
    const opened = await recorder.until((e) => e.type === "request.opened");
    expect(opened).toMatchObject({
      requestType: "permission",
      tool: "list_bots",
      summary: 'Allow the agents MCP server to run tool "list_bots"?',
    });
    expect(opened).not.toMatchObject({ tool: "shell" });

    await instance.adapter.respondToRequest("t-elicit", opened.requestId!, { behavior: "allow" });
    const resolved = await recorder.until((e) => e.type === "request.resolved");
    expect(resolved).toMatchObject({ behavior: "allow", source: "user" });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.decision).toEqual({ action: "accept" });
    expect(seen.decision).not.toHaveProperty("decision");
  });

  it("replies to MCP elicitation Decline with {action: decline}", async () => {
    await create({ mode: "elicitation" });
    const dump = join(scratch, "dump.json");
    process.env.FAKE_CODEX_DUMP = dump;

    await instance.adapter.sendTurn({ threadId: "t-elicit-deny", text: "call list_bots" });
    const opened = await recorder.until((e) => e.type === "request.opened");
    await instance.adapter.respondToRequest("t-elicit-deny", opened.requestId!, { behavior: "deny" });
    await recorder.until((e) => e.type === "turn.completed");
    expect(JSON.parse(readFileSync(dump, "utf8")).decision).toEqual({ action: "decline" });
  });

  it("sends elicitation _meta.persist=always when Always-allow is set", async () => {
    await create({ mode: "elicitation" });
    const dump = join(scratch, "dump.json");
    process.env.FAKE_CODEX_DUMP = dump;

    await instance.adapter.sendTurn({ threadId: "t-elicit-always", text: "call list_bots" });
    const opened = await recorder.until((e) => e.type === "request.opened");
    await instance.adapter.respondToRequest("t-elicit-always", opened.requestId!, { behavior: "allow", always: true });
    await recorder.until((e) => e.type === "turn.completed");
    expect(JSON.parse(readFileSync(dump, "utf8")).decision).toEqual({
      action: "accept",
      _meta: { persist: "always" },
    });
  });

  it("uses the elicitation {action} shape when a stored rule auto-resolves", async () => {
    // Harness Always-allow writes a local rule, then later asks call
    // respondToRequest({ behavior, source: "rule" }) — same finish() as a
    // carded click. Rules are not a workaround; they must not send {decision}.
    await create({ mode: "elicitation" });
    const dump = join(scratch, "dump.json");
    process.env.FAKE_CODEX_DUMP = dump;

    await instance.adapter.sendTurn({ threadId: "t-elicit-rule", text: "call list_bots" });
    const opened = await recorder.until((e) => e.type === "request.opened");
    expect(opened).toMatchObject({ requestType: "permission", tool: "list_bots" });
    await instance.adapter.respondToRequest("t-elicit-rule", opened.requestId!, {
      behavior: "allow",
      source: "rule",
    });
    const resolved = await recorder.until((e) => e.type === "request.resolved");
    expect(resolved).toMatchObject({ behavior: "allow", source: "rule" });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.decision).toEqual({ action: "accept" });
    expect(seen.decision).not.toHaveProperty("decision");
  });

  it("auto-accepts MCP elicitation in fullAuto with {action: accept}", async () => {
    // fullAuto sets approvalPolicy "never", which usually stops Codex from
    // eliciting. If a request still arrives, the reply must still be {action}.
    await create({ mode: "elicitation", fullAuto: true });
    const dump = join(scratch, "dump.json");
    process.env.FAKE_CODEX_DUMP = dump;

    await instance.adapter.sendTurn({ threadId: "t-elicit-auto", text: "call list_bots" });
    await recorder.until((e) => e.type === "turn.completed");
    expect(recorder.events.some((e) => e.type === "request.opened")).toBe(false);
    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.decision).toEqual({ action: "accept" });
    expect(seen.decision).not.toHaveProperty("decision");
  });

  it("requireApproval under fullAuto still replies {action: accept} for elicitation", async () => {
    await create({ mode: "elicitation", fullAuto: true });
    const dump = join(scratch, "dump.json");
    process.env.FAKE_CODEX_DUMP = dump;

    await instance.adapter.sendTurn({
      threadId: "t-elicit-require",
      text: "call list_bots",
      requireApproval: true,
    });
    const opened = await recorder.until((e) => e.type === "request.opened");
    expect(opened).toMatchObject({ requestType: "permission", tool: "list_bots" });
    await instance.adapter.respondToRequest("t-elicit-require", opened.requestId!, { behavior: "allow" });
    await recorder.until((e) => e.type === "turn.completed");
    expect(JSON.parse(readFileSync(dump, "utf8")).decision).toEqual({ action: "accept" });
  });

  it("grants requested permissions on Allow and an empty profile on Decline", async () => {
    await create({ mode: "permissions" });
    const dump = join(scratch, "dump.json");
    process.env.FAKE_CODEX_DUMP = dump;

    await instance.adapter.sendTurn({ threadId: "t-perms", text: "need network" });
    const opened = await recorder.until((e) => e.type === "request.opened");
    expect(opened).toMatchObject({
      requestType: "permission",
      tool: "permissions",
      summary: "Need network to fetch docs",
    });
    await instance.adapter.respondToRequest("t-perms", opened.requestId!, { behavior: "allow" });
    await recorder.until((e) => e.type === "turn.completed");
    expect(JSON.parse(readFileSync(dump, "utf8")).decision).toEqual({
      permissions: { network: { enabled: true } },
      scope: "turn",
    });
  });

  it("declines a permissions request with an empty granted profile", async () => {
    await create({ mode: "permissions" });
    const dump = join(scratch, "dump.json");
    process.env.FAKE_CODEX_DUMP = dump;

    await instance.adapter.sendTurn({ threadId: "t-perms-deny", text: "need network" });
    const opened = await recorder.until((e) => e.type === "request.opened");
    await instance.adapter.respondToRequest("t-perms-deny", opened.requestId!, { behavior: "deny" });
    await recorder.until((e) => e.type === "turn.completed");
    expect(JSON.parse(readFileSync(dump, "utf8")).decision).toEqual({ permissions: {}, scope: "turn" });
  });

  it("replies to v2 command approval with {decision: accept}, not {action}", async () => {
    await create({ mode: "command-approval" });
    const dump = join(scratch, "dump.json");
    process.env.FAKE_CODEX_DUMP = dump;

    await instance.adapter.sendTurn({ threadId: "t-cmd", text: "clean up" });
    const opened = await recorder.until((e) => e.type === "request.opened");
    expect(opened).toMatchObject({ requestType: "permission", tool: "shell", summary: "rm -rf scratch" });
    await instance.adapter.respondToRequest("t-cmd", opened.requestId!, { behavior: "allow" });
    await recorder.until((e) => e.type === "turn.completed");
    expect(JSON.parse(readFileSync(dump, "utf8")).decision).toEqual({ decision: "accept" });
  });

  it("rejects unknown server methods with -32601 instead of a command-approval payload", async () => {
    await create({ mode: "unknown-method" });
    const dump = join(scratch, "dump.json");
    process.env.FAKE_CODEX_DUMP = dump;

    await instance.adapter.sendTurn({ threadId: "t-unknown", text: "go" });
    const error = await recorder.until((e) => e.type === "runtime.error");
    expect(error).toMatchObject({ type: "runtime.error", message: expect.stringMatching(/item\/tool\/call/) });
    expect(recorder.events.some((e) => e.type === "request.opened")).toBe(false);
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.decision).toEqual({ error: { code: -32601, message: "Method not found: item/tool/call" } });
    expect(seen.decision).not.toHaveProperty("decision");
    expect(seen.decision).not.toHaveProperty("action");
  });

  it("does not open OptionCards for conversational requestUserInput", async () => {
    await create({ mode: "user-input" });
    const dump = join(scratch, "dump.json");
    process.env.FAKE_CODEX_DUMP = dump;

    await instance.adapter.sendTurn({ threadId: "t-abc", text: "what next" });
    await recorder.until((e) => e.type === "turn.completed");

    expect(recorder.events.some((e) => e.type === "request.opened")).toBe(false);
    expect(recorder.events.some((e) => e.type === "request.resolved")).toBe(false);
    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.decision.answers.next.answers[0]).toMatch(/create_bot|chat/i);
    expect(JSON.stringify(seen.decision)).not.toMatch(/Create a Chief of Staff/);
  });

  it("still cards requestUserInput when every option is an approval verb", async () => {
    await create({ mode: "user-input-approval" });
    const dump = join(scratch, "dump.json");
    process.env.FAKE_CODEX_DUMP = dump;

    await instance.adapter.sendTurn({ threadId: "t-mcp-ask", text: "create a bot" });
    const opened = await recorder.until((e) => e.type === "request.opened");
    expect(opened).toMatchObject({
      requestType: "permission",
      tool: "ask_user",
      summary: "Allow the agents create_bot tool?",
      choices: ["Accept", "Decline", "Cancel"],
    });

    await instance.adapter.respondToRequest("t-mcp-ask", opened.requestId!, { behavior: "allow" });
    await recorder.until((e) => e.type === "turn.completed");
    expect(JSON.parse(readFileSync(dump, "utf8")).decision).toEqual({
      answers: { mcp_approve: { answers: ["Accept"] } },
    });
  });

  it("emits a credential handoff for a sign-in requestUserInput and keeps secrets out", async () => {
    await create({ mode: "credential" });
    await instance.adapter.sendTurn({ threadId: "t-cred", text: "log in" });
    const opened = await recorder.until((e) => e.type === "request.opened");
    expect(opened).toMatchObject({
      requestType: "credential",
      tool: "ask_user",
    });
    expect(JSON.stringify(opened)).not.toContain("hunter2");
    expect((opened as { summary: string }).summary).not.toContain("hunter2");
    await instance.adapter.respondToRequest("t-cred", opened.requestId!, { behavior: "allow", source: "user" });
    const resolved = await recorder.until((e) => e.type === "request.resolved");
    expect(resolved).toMatchObject({ behavior: "allow", source: "user" });
    await recorder.until((e) => e.type === "turn.completed");
    expect(JSON.stringify(recorder.events)).not.toContain("hunter2");
  });

  it("rejects a second turn while one is in flight", async () => {
    await create({ mode: "approval" }); // approval mode parks the turn open
    await instance.adapter.sendTurn({ threadId: "t-busy", text: "one" });
    await recorder.until((e) => e.type === "request.opened");
    await expect(instance.adapter.sendTurn({ threadId: "t-busy", text: "two" })).rejects.toThrow(/already running/);
    await instance.adapter.interruptTurn("t-busy");
    await recorder.until((e) => e.type === "turn.completed");
  });

  it("a missing binary surfaces as a failed turn, and snapshot says unavailable", async () => {
    instance = await CodexDriver.create({
      instanceId: "codex-missing",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: { cli: join(scratch, "does-not-exist"), fullAuto: false },
    });
    recorder = recordEvents(instance.adapter);

    await instance.adapter.sendTurn({ threadId: "t-missing", text: "go" });
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: false });
    expect(await instance.snapshot()).toMatchObject({ state: "unavailable" });
  });

  it("mounts agents, composio, and cloud computer as mcp_servers on thread/start", async () => {
    await create();
    const dump = join(scratch, "dump.json");
    process.env.FAKE_CODEX_DUMP = dump;
    const composioKey = "sk-composio-secret";

    await instance.adapter.sendTurn({
      threadId: "t-mcp-start",
      text: "use tools",
      integrations: {
        composio: {
          command: process.execPath,
          args: ["/fake/composio-proxy.js"],
          env: { OMB_COMPOSIO_KEY: composioKey, OMB_ALLOWED_TOOLKITS: "googledrive" },
        },
        computer: { boxId: "box-1", token: "box-token" },
        agents: {
          command: process.execPath,
          args: ["/fake/agents-proxy.js"],
          env: { OMB_BOT_ID: "b1", OMB_COMMS_TOKEN: "tok" },
        },
        memory: {
          command: process.execPath,
          args: ["/fake/memory-proxy.js"],
          env: { OMB_BOT_ID: "b1", OMB_COMMS_TOKEN: "memtok" },
        },
        workspace: {
          command: process.execPath,
          args: ["/fake/workspace-proxy.js"],
          env: { OMB_BOT_ID: "b1", OMB_COMMS_TOKEN: "wstok" },
        },
      },
    });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    const mcp = seen.threadStartConfig?.mcp_servers;
    expect(mcp).toBeDefined();
    expect(mcp).toHaveProperty("agents");
    expect(mcp.agents).toBeDefined();
    expect(mcp.agents).toMatchObject({
      command: process.execPath,
      args: ["/fake/agents-proxy.js"],
      env: { OMB_BOT_ID: "b1", OMB_COMMS_TOKEN: "tok" },
    });
    expect(mcp.agents.args.at(-1)).toMatch(/agents-proxy\.(ts|js)$/);
    expect(mcp.memory).toMatchObject({
      command: process.execPath,
      args: ["/fake/memory-proxy.js"],
      env: { OMB_BOT_ID: "b1", OMB_COMMS_TOKEN: "memtok" },
    });
    expect(mcp.memory.args.at(-1)).toMatch(/memory-proxy\.(ts|js)$/);
    expect(mcp.workspace).toMatchObject({
      command: process.execPath,
      args: ["/fake/workspace-proxy.js"],
      env: { OMB_BOT_ID: "b1", OMB_COMMS_TOKEN: "wstok" },
    });
    expect(mcp.workspace.args.at(-1)).toMatch(/workspace-proxy\.(ts|js)$/);
    expect(mcp.composio).toMatchObject({
      command: process.execPath,
      args: ["/fake/composio-proxy.js"],
      env: { OMB_COMPOSIO_KEY: composioKey, OMB_ALLOWED_TOOLKITS: "googledrive" },
    });
    expect(mcp.composio.args.at(-1)).toMatch(/composio-proxy\.(ts|js)$/);
    expect(mcp.computer).toMatchObject({
      command: process.execPath,
      env: {
        ELECTRON_RUN_AS_NODE: "1",
        OGB_BOX_ID: "box-1",
        OGB_BOX_TOKEN: "box-token",
      },
    });
    expect(mcp.computer.args.at(-1)).toMatch(/computer-proxy\.(ts|js)$/);
    expect(JSON.stringify(seen.argv)).not.toContain(composioKey);
  });

  it("mounts localComputer as the computer mcp server", async () => {
    await create();
    const dump = join(scratch, "dump.json");
    process.env.FAKE_CODEX_DUMP = dump;

    await instance.adapter.sendTurn({
      threadId: "t-mcp-local",
      text: "use this mac",
      integrations: {
        localComputer: {
          command: "/fake/cua-driver",
          args: ["mcp", "--embedded", "--socket", "/tmp/cua.sock"],
          env: { CUA: "1" },
        },
      },
    });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.threadStartConfig.mcp_servers.computer).toEqual({
      command: "/fake/cua-driver",
      args: ["mcp", "--embedded", "--socket", "/tmp/cua.sock"],
      env: { CUA: "1" },
    });
    expect(seen.threadStartConfig.mcp_servers.agents).toBeUndefined();
    expect(seen.threadStartConfig.mcp_servers.composio).toBeUndefined();
  });

  it("attaches the same mcp_servers overlay on thread/resume", async () => {
    await create({ mode: "resume" });
    const dump = join(scratch, "dump.json");
    process.env.FAKE_CODEX_DUMP = dump;
    const composioKey = "sk-resume-composio";

    await instance.adapter.sendTurn({
      threadId: "t-resume-mcp",
      text: "again",
      resumeCursor: "codex-thread-9",
      integrations: {
        composio: {
          command: process.execPath,
          args: ["/fake/composio-proxy.js"],
          env: { OMB_COMPOSIO_KEY: composioKey, OMB_ALLOWED_TOOLKITS: "gmail" },
        },
        agents: {
          command: process.execPath,
          args: ["/fake/agents-proxy.js"],
          env: { OMB_BOT_ID: "b1" },
        },
      },
    });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    const methods = seen.calls.map((c: { method: string }) => c.method);
    expect(methods).toContain("thread/resume");
    expect(methods).not.toContain("thread/start");
    expect(seen.threadStartConfig).toBeNull();
    const mcp = seen.threadResumeConfig?.mcp_servers;
    expect(mcp).toBeDefined();
    expect(mcp).toHaveProperty("agents");
    expect(mcp.agents).toBeDefined();
    expect(mcp.agents).toMatchObject({
      command: process.execPath,
      args: ["/fake/agents-proxy.js"],
    });
    expect(mcp.agents.args.at(-1)).toMatch(/agents-proxy\.(ts|js)$/);
    expect(mcp.composio.env.OMB_COMPOSIO_KEY).toBe(composioKey);
    expect(mcp.composio.env.OMB_ALLOWED_TOOLKITS).toBe("gmail");
    expect(JSON.stringify(seen.argv)).not.toContain(composioKey);
  });

  it("a clean exit 0 before turn/completed is a finished turn, not a kill", async () => {
    await create({ mode: "exit-zero" });
    await instance.adapter.sendTurn({ threadId: "t-exit0", text: "go" });
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ type: "turn.completed", ok: true, stopReason: null });
    expect(recorder.events.some((e) => e.type === "runtime.error")).toBe(false);
    const text = recorder.events.find((e: any) => e.type === "item.completed" && e.itemType === "assistant_text");
    expect(text).toMatchObject({ text: "done from fake codex" });
  });

  it("a non-zero exit before turn/completed is still a failed turn", async () => {
    await create({ mode: "exit-early" });
    await instance.adapter.sendTurn({ threadId: "t-crash", text: "go" });
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: false, stopReason: "exit_before_result" });
    const error = recorder.events.find((e) => e.type === "runtime.error")!;
    expect(error.message).toContain("codex exited 3");
  });
});
