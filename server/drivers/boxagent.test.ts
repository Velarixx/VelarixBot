// Box agent asks: fake box HTTP path only — no live ascii.dev.
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import type { ProviderInstance } from "../contracts.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import { BoxAgentDriver } from "./boxagent.ts";

function startFakeBox(script: {
  events: unknown[];
  onAsk?: (body: unknown) => void;
  status?: () => string;
}): Promise<{ server: Server; base: string }> {
  let promptStatus = "running";
  const server = createServer((req, res) => {
    const url = req.url ?? "";
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url === "/me") return json(200, { ok: true });
    if (req.method === "POST" && /\/boxes\/[^/]+\/prompt$/.test(url)) {
      return json(200, { ok: true, prompt: { id: "p-1" } });
    }
    if (/\/boxes\/[^/]+\/events$/.test(url)) {
      return json(200, { ok: true, events: script.events });
    }
    if (/\/boxes\/[^/]+\/prompts\//.test(url)) {
      return json(200, { ok: true, prompt: { status: script.status?.() ?? promptStatus, result: "done" } });
    }
    if (req.method === "POST" && /\/asks\//.test(url)) {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        script.onAsk?.(JSON.parse(data || "{}"));
        promptStatus = "completed";
        json(200, { ok: true });
      });
      return;
    }
    if (req.method === "POST" && /interrupt/.test(url)) {
      promptStatus = "cancelled";
      return json(200, { ok: true });
    }
    json(404, { error: "nope" });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

describe("BoxAgentDriver.decodeConfig", () => {
  it("defaults to the live box API and a 2.5s poll", () => {
    expect(BoxAgentDriver.decodeConfig({})).toEqual({ pollMs: 2500, apiBase: "https://ascii.dev/api/box/v1" });
  });

  it("accepts a fake apiBase for tests", () => {
    expect(BoxAgentDriver.decodeConfig({ apiBase: "http://127.0.0.1:9/", pollMs: 10 })).toEqual({
      pollMs: 10,
      apiBase: "http://127.0.0.1:9",
    });
  });
});

describe("BoxAgentDriver asks (fake box)", () => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;
  let server: Server;

  afterEach(async () => {
    recorder?.stop();
    await instance?.dispose();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  });

  it("emits request.opened for a box ask and resolves allow/deny without throwing", async () => {
    const answers: unknown[] = [];
    const fake = await startFakeBox({
      events: [
        {
          id: "ask-1",
          type: "ask",
          tool: "shell",
          summary: "rm scratch",
        },
      ],
      onAsk: (body) => answers.push(body),
      status: () => (answers.length ? "completed" : "running"),
    });
    server = fake.server;
    instance = await BoxAgentDriver.create({
      instanceId: "box-test",
      displayName: "Box Test",
      environment: { BOX_TOKEN: "tok_test" },
      enabled: true,
      config: { pollMs: 5, apiBase: fake.base },
    });
    recorder = recordEvents(instance.adapter);

    await instance.adapter.sendTurn({
      threadId: "t-box-ask",
      text: "go",
      integrations: { computer: { boxId: "box-1", token: "tok_test" } },
    });
    const opened = await recorder.until((e) => e.type === "request.opened");
    expect(opened).toMatchObject({
      type: "request.opened",
      requestId: "ask-1",
      requestType: "permission",
      tool: "shell",
      summary: "rm scratch",
      provider: "boxAgent",
    });

    await instance.adapter.respondToRequest("t-box-ask", "ask-1", { behavior: "allow" });
    const resolved = await recorder.until((e) => e.type === "request.resolved");
    expect(resolved).toMatchObject({ behavior: "allow", source: "user", requestId: "ask-1" });
    expect(answers[0]).toMatchObject({ behavior: "allow" });
    await recorder.until((e) => e.type === "turn.completed");
  });

  it("no longer throws 'box agent asks are not wired yet'", async () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "boxagent.ts"), "utf8");
    expect(src).not.toContain("box agent asks are not wired yet");
    const fake = await startFakeBox({ events: [] });
    server = fake.server;
    instance = await BoxAgentDriver.create({
      instanceId: "box-test-2",
      displayName: undefined,
      environment: { BOX_TOKEN: "tok_test" },
      enabled: true,
      config: { pollMs: 5, apiBase: fake.base },
    });
    recorder = recordEvents(instance.adapter);
    await instance.adapter.sendTurn({
      threadId: "t-empty",
      text: "go",
      integrations: { computer: { boxId: "box-1", token: "tok_test" } },
    });
    await expect(
      instance.adapter.respondToRequest("t-empty", "never-asked", { behavior: "deny" }),
    ).rejects.toThrow(/pending request/);
    await instance.adapter.interruptTurn("t-empty");
    await recorder.until((e) => e.type === "turn.completed");
  });
});
