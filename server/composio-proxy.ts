// Composio MCP proxy — stdio JSON-RPC the agent CLIs spawn. Forwards
// tools/list and tools/call to the Connect HTTP MCP, filtered by
// OMB_ALLOWED_TOOLKITS so a bot only sees the apps it is toggled for.
// The consumer key stays in env (never argv, never stdout).
import readline from "node:readline";

import { parseAllowedToolkits, toolAllowedForApps } from "./composio-filter.ts";

const CONNECT_URL = "https://connect.composio.dev/mcp";
const URL = (process.env.OMB_COMPOSIO_URL || "").trim() || CONNECT_URL;
const KEY = process.env.OMB_COMPOSIO_KEY ?? "";
const ALLOWED = parseAllowedToolkits(process.env.OMB_ALLOWED_TOOLKITS ?? "");

type Json = Record<string, unknown>;
const send = (msg: Json) => process.stdout.write(JSON.stringify(msg) + "\n");
const ok = (id: unknown, result: unknown) => send({ jsonrpc: "2.0", id, result });
const rpcErr = (id: unknown, code: number, message: string) => send({ jsonrpc: "2.0", id, error: { code, message } });
const textResult = (id: unknown, text: string, isError = false) =>
  ok(id, { content: [{ type: "text", text }], isError });

function parseMcpResponse(text: string) {
  const line = text.startsWith("{") ? text : text.split("\n").find((l) => l.startsWith("data: "))?.slice(6);
  if (!line) throw new Error("empty MCP response");
  const msg = JSON.parse(line);
  if (msg.error) throw new Error(msg.error.message || "MCP error");
  return msg.result ?? null;
}

async function remote(method: string, params: unknown): Promise<unknown> {
  if (!KEY) throw new Error("no Composio key configured");
  const res = await fetch(URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "x-consumer-api-key": KEY,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Composio MCP: HTTP ${res.status}`);
  return parseMcpResponse(await res.text());
}

async function handle(msg: Json) {
  const id = msg.id;
  const method = msg.method as string | undefined;
  if (!method) return;
  const params = (msg.params ?? {}) as Json;
  switch (method) {
    case "initialize":
      ok(id, {
        protocolVersion: (params.protocolVersion as string) ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "velarixbot-composio", version: "0.1.0" },
      });
      return;
    case "notifications/initialized":
    case "notifications/cancelled":
      return;
    case "ping":
      ok(id, {});
      return;
    case "tools/list": {
      if (!ALLOWED.length) {
        ok(id, { tools: [] });
        return;
      }
      try {
        const result = (await remote("tools/list", {})) as { tools?: Array<{ name?: string }> } | null;
        const tools = (result?.tools ?? []).filter((t) => toolAllowedForApps(String(t?.name ?? ""), ALLOWED));
        ok(id, { tools });
      } catch (e) {
        rpcErr(id, -32603, (e as Error).message);
      }
      return;
    }
    case "tools/call": {
      const name = String(params.name ?? "");
      if (!toolAllowedForApps(name, ALLOWED)) {
        textResult(id, `This bot is not allowed to use ${name || "that app"}.`, true);
        return;
      }
      try {
        const result = await remote("tools/call", { name, arguments: params.arguments ?? {} });
        ok(id, result);
      } catch (e) {
        textResult(id, (e as Error).message, true);
      }
      return;
    }
    default:
      if (id !== undefined) rpcErr(id, -32601, `Method not found: ${method}`);
  }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  const t = line.trim();
  if (!t) return;
  let msg: Json;
  try {
    msg = JSON.parse(t) as Json;
  } catch {
    return;
  }
  void handle(msg).catch((e) => {
    if (msg.id !== undefined) rpcErr(msg.id, -32603, (e as Error).message);
  });
});
rl.on("close", () => process.exit(0));
