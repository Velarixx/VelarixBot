// Contract tests for the OpenAI-compatible chat drivers (OpenRouter /
// OmniRouter). A local HTTP fake speaks SSE — no live API, no sleeps.
import { createServer, type Server } from "node:http";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "../config.ts";
import type { ProviderDriver, ProviderInstance } from "../contracts.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import { ProviderRegistry } from "../harness/registry.ts";
import { OmniRouterDriver } from "./omnirouter.ts";
import { scrubCompatSecret } from "./openai-compat.ts";
import { OpenRouterDriver } from "./openrouter.ts";

function startFakeCompletions(script: {
  status?: number;
  body?: string;
  sse?: string[];
  hang?: boolean;
  onRequest?: (req: { url?: string; authorization?: string; raw: string }) => void;
}): Promise<{ server: Server; base: string; requests: () => number }> {
  let requests = 0;
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      requests += 1;
      script.onRequest?.({
        url: req.url,
        authorization: typeof req.headers.authorization === "string" ? req.headers.authorization : undefined,
        raw,
      });
      if (req.method !== "POST" || req.url !== "/chat/completions") {
        res.writeHead(404, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: "nope" }));
      }
      if (script.hang) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        return;
      }
      const status = script.status ?? 200;
      if (status !== 200) {
        res.writeHead(status, { "content-type": "application/json" });
        return res.end(script.body ?? JSON.stringify({ error: { message: "unauthorized sk-or-v1-secretvalue" } }));
      }
      const parsed = JSON.parse(raw || "{}") as { stream?: boolean };
      if (parsed.stream === false) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(
          JSON.stringify({
            choices: [{ message: { content: "one-shot note" } }],
            usage: { prompt_tokens: 2, completion_tokens: 3 },
          }),
        );
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const frames = script.sse ?? [
        'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":" there"}}],"usage":{"prompt_tokens":4,"completion_tokens":2}}\n\n',
        "data: [DONE]\n\n",
      ];
      for (const frame of frames) res.write(frame);
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({ server, base: `http://127.0.0.1:${port}`, requests: () => requests });
    });
  });
}

async function create(
  driver: ProviderDriver,
  url: string,
  env: Record<string, string> = { OPENROUTER_API_KEY: "sk-or-v1-testkey", OMNIROUTER_API_KEY: "omni-testkey" },
): Promise<{ instance: ProviderInstance; recorder: EventRecorder }> {
  const instance = await driver.create({
    instanceId: "t1",
    displayName: driver.metadata.displayName,
    environment: env,
    enabled: true,
    config: driver.decodeConfig({ url }),
  });
  return { instance, recorder: recordEvents(instance.adapter) };
}

describe("OpenRouterDriver.decodeConfig", () => {
  it("throws on invalid config and defaults a real object", () => {
    expect(() => OpenRouterDriver.decodeConfig("nope")).toThrow(/object/);
    expect(() => OpenRouterDriver.decodeConfig({ url: 1 })).toThrow(/url/);
    expect(() => OpenRouterDriver.decodeConfig({ url: "ftp://x" })).toThrow(/http/);
    expect(() => OpenRouterDriver.decodeConfig({ apiKeyEnv: "" })).toThrow(/apiKeyEnv/);
    expect(OpenRouterDriver.decodeConfig({})).toEqual({
      url: "https://openrouter.ai/api/v1",
      apiKeyEnv: "OPENROUTER_API_KEY",
    });
    expect(OpenRouterDriver.decodeConfig({ url: "http://127.0.0.1:9/v1/" })).toEqual({
      url: "http://127.0.0.1:9/v1",
      apiKeyEnv: "OPENROUTER_API_KEY",
    });
  });
});

describe("OmniRouterDriver.decodeConfig", () => {
  it("throws on invalid config and defaults to the hosted v1 URL", () => {
    expect(() => OmniRouterDriver.decodeConfig(null)).toThrow(/object/);
    expect(OmniRouterDriver.decodeConfig(undefined)).toEqual({
      url: "https://omnirouters.com/v1",
      apiKeyEnv: "OMNIROUTER_API_KEY",
    });
  });
});

describe("registry: decodeConfig throw vs missing key", () => {
  it("invalid config is a shadow; missing key is live with unavailable snapshot", async () => {
    const registry = new ProviderRegistry([OpenRouterDriver]);
    await registry.load({
      bad: { driver: "openrouter", config: { url: "ftp://nope" } },
      empty: { driver: "openrouter", config: { apiKeyEnv: "VELARIXBOT_TEST_NO_OPENROUTER_KEY" } },
    });
    const described = await registry.describe();
    const bad = described.find((d) => d.instanceId === "bad")!;
    expect(bad.snapshot.state).toBe("unavailable");
    expect(bad.snapshot.reason).toMatch(/http/);
    expect(registry.get("bad")).toBeNull();
    const empty = described.find((d) => d.instanceId === "empty")!;
    expect(empty.snapshot.state).toBe("unavailable");
    expect(empty.snapshot.reason).toMatch(/OpenRouter API key/);
    expect(registry.get("empty")).not.toBeNull();
    await registry.disposeAll();
  });
});

describe("missing key is unavailable, never a hang", () => {
  it("OpenRouter snapshot explains the missing key and create still resolves", async () => {
    let syncThrow: unknown;
    let pending: Promise<ProviderInstance> | undefined;
    try {
      pending = OpenRouterDriver.create({
        instanceId: "or-empty",
        displayName: "OpenRouter",
        environment: {},
        enabled: true,
        config: OpenRouterDriver.decodeConfig({ apiKeyEnv: "VELARIXBOT_TEST_NO_OPENROUTER_KEY" }),
      });
    } catch (e) {
      syncThrow = e;
    }
    expect(syncThrow).toBeUndefined();
    expect(pending).toBeInstanceOf(Promise);
    const instance = await pending!;
    const snap = await instance.snapshot();
    expect(snap.state).toBe("unavailable");
    expect(snap.reason).toMatch(/OpenRouter API key/);
    expect(instance.generateText).toBeUndefined();
    await expect(instance.adapter.sendTurn({ threadId: "t", text: "hi" })).rejects.toThrow(/OpenRouter API key/);
    await instance.dispose();
  });

  it("OmniRouter snapshot explains the missing key", async () => {
    const instance = await OmniRouterDriver.create({
      instanceId: "om-empty",
      displayName: "OmniRouter",
      environment: {},
      enabled: true,
      config: OmniRouterDriver.decodeConfig({ apiKeyEnv: "VELARIXBOT_TEST_NO_OMNIROUTER_KEY" }),
    });
    const snap = await instance.snapshot();
    expect(snap.state).toBe("unavailable");
    expect(snap.reason).toMatch(/OmniRouter API key/);
    await instance.dispose();
  });
});

describe("OpenAI-compat streaming (fake HTTP)", () => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;
  let server: Server | undefined;

  afterEach(async () => {
    recorder?.stop();
    await instance?.dispose();
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  });

  it("streams deltas into canonical events and does not leak the key", async () => {
    const fake = await startFakeCompletions({});
    server = fake.server;
    const created = await create(OpenRouterDriver, fake.base);
    instance = created.instance;
    recorder = created.recorder;

    expect((await instance.snapshot()).state).toBe("available");
    mkdirSync(join(DATA_DIR, "native"), { recursive: true });
    await instance.adapter.sendTurn({ threadId: "t-ok", text: "hi", model: "openai/gpt-4o-mini" });
    const done = await recorder.until((e) => e.type === "turn.completed" && e.threadId === "t-ok");
    expect(done).toMatchObject({ ok: true, provider: "openrouter" });
    expect(recorder.events.map((e) => e.type)).toEqual([
      "turn.started",
      "session.started",
      "content.delta",
      "content.delta",
      "item.completed",
      "thread.token-usage.updated",
      "turn.completed",
    ]);
    const text = recorder.events.find((e) => e.type === "item.completed" && e.itemType === "assistant_text");
    expect(text).toMatchObject({ text: "hello there" });
    expect(JSON.stringify(recorder.events)).not.toContain("sk-or-v1-testkey");
    const native = readFileSync(join(DATA_DIR, "native", "t-ok.ndjson"), "utf8");
    expect(native).not.toContain("sk-or-v1-testkey");
    expect(native).not.toContain("Bearer");
  });

  it("HTTP 401 is a failed turn with a scrubbed reason, one request, no failover", async () => {
    const fake = await startFakeCompletions({ status: 401 });
    server = fake.server;
    const created = await create(OpenRouterDriver, fake.base);
    instance = created.instance;
    recorder = created.recorder;

    await instance.adapter.sendTurn({ threadId: "t-401", text: "hi" });
    const done = await recorder.until((e) => e.type === "turn.completed" && e.threadId === "t-401");
    expect(done).toMatchObject({ ok: false, stopReason: "error" });
    const err = recorder.events.find((e) => e.type === "runtime.error");
    expect(err).toBeTruthy();
    expect(JSON.stringify(err)).not.toContain("sk-or-v1-secretvalue");
    expect(JSON.stringify(err)).not.toContain("sk-or-v1-testkey");
    expect(fake.requests()).toBe(1);
  });

  it("OmniRouter generateText uses the non-stream path on the same fake", async () => {
    const fake = await startFakeCompletions({});
    server = fake.server;
    const created = await create(OmniRouterDriver, fake.base, { OMNIROUTER_API_KEY: "omni-testkey" });
    instance = created.instance;
    recorder = created.recorder;
    const text = await instance.generateText!("summarize");
    expect(text).toBe("one-shot note");
    expect(fake.requests()).toBe(1);
  });

  it("interrupt aborts an in-flight stream as a failed turn, not a hang", async () => {
    const fake = await startFakeCompletions({ hang: true });
    server = fake.server;
    const created = await create(OpenRouterDriver, fake.base);
    instance = created.instance;
    recorder = created.recorder;
    await instance.adapter.sendTurn({ threadId: "t-int", text: "hi" });
    await recorder.until((e) => e.type === "turn.started");
    await instance.adapter.interruptTurn("t-int");
    const done = await recorder.until((e) => e.type === "turn.completed" && e.threadId === "t-int");
    expect(done).toMatchObject({ ok: false, stopReason: "interrupted" });
    expect(recorder.events.some((e) => e.type === "runtime.error")).toBe(false);
  });
});

describe("scrubCompatSecret", () => {
  it("redacts bearer tokens and OpenRouter keys", () => {
    expect(scrubCompatSecret("Bearer sk-or-v1-secretvalue oops")).toBe("Bearer [redacted] oops");
    expect(scrubCompatSecret("key sk-or-v1-secretvalue")).not.toContain("secretvalue");
    expect(scrubCompatSecret("gateway echoed omni-testkey-xyz", "omni-testkey-xyz")).not.toContain("omni-testkey-xyz");
  });
});
