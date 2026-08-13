// Contract test for the workspace CoS MCP proxy: spawn it the way a
// driver's mcpServers entry does against a scripted harness stub.
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PROXY = join(dirname(fileURLToPath(import.meta.url)), "workspace-proxy.ts");
const TOKEN = "test-workspace-token";

let stub: Server;
let stubPort = 0;
let lastAuth: string | undefined;
let lastBody: any = null;
let harnessResponse: unknown = { text: "ok" };

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
    if (req.method === "POST" && req.url === "/api/internal/workspace") {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        lastBody = JSON.parse(data);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(harnessResponse));
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
      OMB_BOT_ID: "bot-cos",
      OMB_COMMS_TOKEN: TOKEN,
      OMB_TURN_DEPTH: "0",
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

describe("workspace-proxy MCP surface", () => {
  it("answers the MCP handshake and lists CoS tools", async () => {
    const init = await rpc("initialize", { protocolVersion: "2024-11-05" });
    expect(init.result.serverInfo.name).toContain("workspace");
    const list = await rpc("tools/list");
    expect(list.result.tools.map((t: { name: string }) => t.name)).toEqual([
      "web_search",
      "fetch_page",
      "ask_choice",
      "ask_secret",
      "create_routine",
      "save_skill",
      "run_skill",
      "attach_to_chat",
      "connect_app",
    ]);
  });

  it("forwards web_search with the boot token in the Authorization header, not the body", async () => {
    harnessResponse = { text: "Search: cats\nCats are mammals." };
    const res = await callTool("web_search", { query: "cats" });
    expect(res.result.isError).toBeFalsy();
    expect(res.result.content[0].text).toContain("Cats are mammals");
    expect(lastAuth).toBe(`Bearer ${TOKEN}`);
    expect(lastBody).toMatchObject({
      fromBotId: "bot-cos",
      tool: "web_search",
      args: { query: "cats" },
      depth: 0,
    });
    expect(JSON.stringify(lastBody)).not.toContain(TOKEN);
  });

  it("surfaces a harness error as a tool error without putting the token in argv-shaped fields", async () => {
    harnessResponse = { error: "Composio Connect is not configured. Never ask them to paste a token in chat." };
    const res = await callTool("connect_app", { slug: "github" });
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain("Composio");
    expect(res.result.content[0].text).toMatch(/paste a token/i);
    expect(lastBody).toMatchObject({ tool: "connect_app", args: { slug: "github" } });
    expect(JSON.stringify(lastBody)).not.toContain(TOKEN);
  });

  it("returns ask_secret text to the caller (the bot) and does not put the value in the outbound body", async () => {
    harnessResponse = { text: "wifi-password-xyz" };
    const res = await callTool("ask_secret", { prompt: "wifi password" });
    expect(res.result.isError).toBeFalsy();
    expect(res.result.content[0].text).toBe("wifi-password-xyz");
    expect(lastBody.args).toEqual({ prompt: "wifi password" });
    expect(JSON.stringify(lastBody)).not.toContain("wifi-password-xyz");
    expect(JSON.stringify(lastBody)).not.toContain(TOKEN);
  });

  it("rejects unknown tools with -32602", async () => {
    const res = await rpc("tools/call", { name: "made_up", arguments: {} });
    expect(res.error.code).toBe(-32602);
  });
});
