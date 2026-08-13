// Contract test for the memory MCP proxy (memory-proxy.ts): spawn it the
// way a driver's mcpServers entry does (process.execPath + entry file +
// env) against a scripted stub of the harness's /api/internal remember
// and recall endpoints. No shebang, no shell — plain node child, so this
// runs on every OS like agents-proxy.test.ts.
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PROXY = join(dirname(fileURLToPath(import.meta.url)), "memory-proxy.ts");
const TOKEN = "test-memory-token";

let stub: Server;
let stubPort = 0;
let lastAuth: string | undefined;
let lastRememberBody: any = null;
let lastRecallBody: any = null;
let rememberResponse: unknown = { ok: true };
let recallResponse: unknown = { text: "Shared workspace notes:\nTeam ships on Fridays." };

let child: ChildProcess;
const pending = new Map<number, (msg: any) => void>();
let nextId = 100;

function rpc(method: string, params?: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`${method} timed out`));
    }, 10_000).unref?.();
  });
}
const callTool = (name: string, args: unknown) => rpc("tools/call", { name, arguments: args });

beforeAll(async () => {
  stub = createServer((req, res) => {
    lastAuth = req.headers.authorization;
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "unauthorized" }));
    }
    if (req.method === "POST" && req.url === "/api/internal/remember") {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        lastRememberBody = JSON.parse(data);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(rememberResponse));
      });
      return;
    }
    if (req.method === "POST" && req.url === "/api/internal/recall") {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        lastRecallBody = JSON.parse(data);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(recallResponse));
      });
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "unknown" }));
  });
  await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
  stubPort = (stub.address() as { port: number }).port;

  child = spawn(process.execPath, [PROXY], {
    env: {
      ...process.env,
      OMB_HARNESS_URL: `http://127.0.0.1:${stubPort}`,
      OMB_BOT_ID: "bot-memory",
      OMB_COMMS_TOKEN: TOKEN,
    },
    stdio: ["pipe", "pipe", "inherit"],
  });
  let buf = "";
  child.stdout!.on("data", (c) => {
    buf += c;
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      pending.get(msg.id)?.(msg);
      pending.delete(msg.id);
    }
  });
});

afterAll(async () => {
  child?.kill();
  await new Promise<void>((r) => stub.close(() => r()));
});

describe("memory-proxy MCP surface", () => {
  it("answers the MCP handshake and lists remember and recall", async () => {
    const init = await rpc("initialize", { protocolVersion: "2024-11-05" });
    expect(init.result.serverInfo.name).toContain("memory");
    const list = await rpc("tools/list");
    expect(list.result.tools.map((t: { name: string }) => t.name)).toEqual(["remember", "recall"]);
    expect(list.result.tools.find((t: { name: string }) => t.name === "recall").annotations).toEqual({
      readOnlyHint: true,
    });
    expect(list.result.tools.find((t: { name: string }) => t.name === "remember").annotations).toBeUndefined();
  });

  it("remember forwards bot notes and authenticates with the shared token", async () => {
    rememberResponse = { ok: true };
    const res = await callTool("remember", { note: "Call me Sam." });
    expect(res.result.content[0].text).toContain("this bot");
    expect(res.result.isError).toBeFalsy();
    expect(lastRememberBody).toMatchObject({ fromBotId: "bot-memory", note: "Call me Sam.", scope: "bot" });
    expect(lastAuth).toBe(`Bearer ${TOKEN}`);
    expect(JSON.stringify(lastRememberBody)).not.toContain(TOKEN);
  });

  it("remember with scope=workspace writes the shared file", async () => {
    const res = await callTool("remember", { note: "Ship on Fridays.", scope: "workspace" });
    expect(res.result.content[0].text).toContain("workspace");
    expect(lastRememberBody).toMatchObject({ fromBotId: "bot-memory", note: "Ship on Fridays.", scope: "workspace" });
  });

  it("requires a note", async () => {
    const res = await callTool("remember", { note: "  " });
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain("note");
  });

  it("recall returns harness text and optional query", async () => {
    recallResponse = { text: "Shared workspace notes:\nTeam ships on Fridays." };
    const res = await callTool("recall", { query: "Friday" });
    expect(res.result.content[0].text).toContain("Fridays");
    expect(lastRecallBody).toMatchObject({ fromBotId: "bot-memory", query: "Friday" });
    expect(lastAuth).toBe(`Bearer ${TOKEN}`);
  });

  it("recall omits query when the caller did not pass one", async () => {
    await callTool("recall", {});
    expect(lastRecallBody).toMatchObject({ fromBotId: "bot-memory" });
    expect(lastRecallBody.query).toBeUndefined();
  });

  it("rejects unknown tools with -32602", async () => {
    const res = await rpc("tools/call", { name: "embed", arguments: {} });
    expect(res.error.code).toBe(-32602);
  });
});
