// ACP driver contract tests, run against the scripted fake ACP CLI in
// server/testing/fake-acp-cli.ts. Covers the shared acp/core.ts runtime via
// its two harness shims (grok = fail-closed auth, gemini = lenient auth):
// normalize the ACP handshake into canonical events, keep argv/env hygiene,
// broker permission asks, and settle interrupts/crashes cleanly.
//
// Spawn-based tests are POSIX-only until Windows CLI spawning lands (the fake
// CLI is a shebang script Windows cannot exec directly).
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureDirs, DATA_DIR } from "../../config.ts";
import type { ProviderInstance } from "../../contracts.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
import { GrokAgentDriver } from "./grok.ts";
import { GeminiAgentDriver } from "./gemini.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "testing", "fake-acp-cli.ts");
const posixOnly = describe.skipIf(process.platform === "win32");

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

posixOnly("ACP turns (fake CLI)", () => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;
  let scratch: string;

  const create = async (driver = GrokAgentDriver, mode?: string) => {
    if (mode) process.env.FAKE_ACP_MODE = mode;
    instance = await driver.create({
      instanceId: "acp-test",
      displayName: "ACP Test",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    recorder = recordEvents(instance.adapter);
  };

  beforeEach(() => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
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
});

describe.skipIf(process.platform === "win32")("ACP snapshot", () => {
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
