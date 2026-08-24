import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { parseAllowedToolkits, toolAllowedForApps } from "./composio-filter.ts";

const PROXY = join(dirname(fileURLToPath(import.meta.url)), "composio-proxy.ts");
const KEY = "ck_test_secret_key";

describe("composio toolkit filter", () => {
  it("lets Drive tools through for Drive-only bots and blocks Gmail", () => {
    const drive = ["googledrive"];
    expect(toolAllowedForApps("GOOGLEDRIVE_LIST_FILES", drive)).toBe(true);
    expect(toolAllowedForApps("GMAIL_SEND_EMAIL", drive)).toBe(false);
    expect(toolAllowedForApps("COMPOSIO_MANAGE_CONNECTIONS", drive)).toBe(false);
    expect(toolAllowedForApps("GOOGLEDRIVE_LIST_FILES", [])).toBe(false);
  });

  it("parses slug lists", () => {
    expect(parseAllowedToolkits("googledrive, gmail")).toEqual(["googledrive", "gmail"]);
  });
});

describe("composio-proxy MCP surface", () => {
  let stub: Server;
  let stubPort = 0;
  let lastAuth: string | undefined;
  let lastCall: { name?: string } | null = null;
  let listHits = 0;
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

  beforeAll(async () => {
    stub = createServer((req, res) => {
      lastAuth = req.headers["x-consumer-api-key"] as string | undefined;
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        const msg = JSON.parse(data || "{}");
        if (msg.method === "tools/list") {
          listHits += 1;
          res.writeHead(200, { "content-type": "application/json" });
          return res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              result: {
                tools: [
                  { name: "GOOGLEDRIVE_LIST_FILES", description: "List Drive files" },
                  { name: "GMAIL_SEND_EMAIL", description: "Send mail" },
                ],
              },
            }),
          );
        }
        if (msg.method === "tools/call") {
          lastCall = msg.params;
          if (msg.params?.name === "GOOGLEDRIVE_STALE") {
            res.writeHead(401, { "content-type": "application/json" });
            return res.end(JSON.stringify({ error: "unauthorized" }));
          }
          res.writeHead(200, { "content-type": "application/json" });
          return res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              result: { content: [{ type: "text", text: `ran ${msg.params.name}` }] },
            }),
          );
        }
        res.writeHead(404).end();
      });
    });
    await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
    stubPort = (stub.address() as { port: number }).port;

    child = spawn(process.execPath, [PROXY], {
      env: {
        ...process.env,
        OMB_COMPOSIO_URL: `http://127.0.0.1:${stubPort}`,
        OMB_COMPOSIO_KEY: KEY,
        OMB_ALLOWED_TOOLKITS: "googledrive",
        OMB_COMPOSIO_TOOL_GEN: "7",
        OMB_COMPOSIO_CACHE_ID: "drive-bot",
      },
      stdio: ["pipe", "pipe", "pipe"],
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

  it("bot A (Drive) sees Drive tools and not Gmail", async () => {
    const init = await rpc("initialize", { protocolVersion: "2024-11-05" });
    expect(init.result.serverInfo.name).toContain("composio");
    const list = await rpc("tools/list");
    const names = list.result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(["GOOGLEDRIVE_LIST_FILES"]);
    expect(lastAuth).toBe(KEY);
    expect(listHits).toBe(1);
    const again = await rpc("tools/list");
    expect(again.result.tools.map((t: { name: string }) => t.name)).toEqual(["GOOGLEDRIVE_LIST_FILES"]);
    expect(listHits).toBe(1);
  });

  it("forwards an allowed Drive call and refuses Gmail", async () => {
    const ok = await rpc("tools/call", { name: "GOOGLEDRIVE_LIST_FILES", arguments: {} });
    expect(ok.result.content[0].text).toContain("GOOGLEDRIVE_LIST_FILES");
    expect(lastCall).toMatchObject({ name: "GOOGLEDRIVE_LIST_FILES" });
    const denied = await rpc("tools/call", { name: "GMAIL_SEND_EMAIL", arguments: {} });
    expect(denied.result.isError).toBe(true);
    expect(denied.result.content[0].text).toMatch(/not allowed/i);
    expect(JSON.stringify(ok)).not.toContain(KEY);
  });

  it("invalidates the cached tool list after a stale-auth failure", async () => {
    const hitsBefore = listHits;
    const stale = await rpc("tools/call", { name: "GOOGLEDRIVE_STALE", arguments: {} });
    expect(stale.result.isError).toBe(true);
    expect(stale.result.content[0].text).toMatch(/401|unauthorized|stale/i);
    expect(JSON.stringify(stale)).not.toContain(KEY);
    const list = await rpc("tools/list");
    expect(list.result.tools.map((t: { name: string }) => t.name)).toEqual(["GOOGLEDRIVE_LIST_FILES"]);
    expect(listHits).toBe(hitsBefore + 1);
  });
});
