// Memory MCP proxy — spawned as an MCP server inside a bot's agent
// process (via the "memory" integration). Exposes tools that read and
// write the same local markdown files the harness injects on startTurn:
//
//   remember(note, scope?)  → append a lasting note (this bot or workspace)
//   recall(query?)          → read those notes (optional substring filter)
//
// Speaks raw JSON-RPC 2.0 over stdio (no MCP SDK — house style, matches
// agents-proxy / computer-proxy). All state comes from env:
//   OMB_HARNESS_URL  base URL of the harness (http://127.0.0.1:8799)
//   OMB_BOT_ID       the calling bot's id
//   OMB_COMMS_TOKEN  shared secret for the localhost-only internal endpoints
//
// stdout is the MCP channel — never console.log here. The proxy never
// logs notes or the token.
import readline from "node:readline";

const HARNESS = process.env.OMB_HARNESS_URL ?? "http://127.0.0.1:8799";
const BOT_ID = process.env.OMB_BOT_ID ?? "";
const TOKEN = process.env.OMB_COMMS_TOKEN ?? "";

const TOOLS = [
  {
    name: "remember",
    description:
      "Save a lasting note for this bot or the shared workspace. Use it for durable facts, preferences, and decisions — not chit-chat. scope=bot (default) stays on this bot; scope=workspace is visible to every bot.",
    inputSchema: {
      type: "object",
      properties: {
        note: { type: "string", description: "The note to keep." },
        scope: {
          type: "string",
          enum: ["bot", "workspace"],
          description: "bot = this bot's notes (default). workspace = shared workspace.md.",
        },
      },
      required: ["note"],
    },
  },
  {
    name: "recall",
    description:
      "Read this bot's notes and the shared workspace notes. Optional query is a plain substring filter (no embeddings).",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Optional case-insensitive substring to match." },
      },
    },
    annotations: { readOnlyHint: true },
  },
];

type Json = Record<string, unknown>;
const send = (msg: Json) => process.stdout.write(JSON.stringify(msg) + "\n");
const ok = (id: unknown, result: unknown) => send({ jsonrpc: "2.0", id, result });
const rpcErr = (id: unknown, code: number, message: string) => send({ jsonrpc: "2.0", id, error: { code, message } });
const textResult = (id: unknown, text: string, isError = false) =>
  ok(id, { content: [{ type: "text", text }], isError });

async function api(path: string, init?: RequestInit): Promise<Json> {
  const res = await fetch(HARNESS + path, {
    ...init,
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}`, ...(init?.headers ?? {}) },
  });
  const body = (await res.json().catch(() => ({}))) as Json;
  if (!res.ok) throw new Error(String(body.error ?? `HTTP ${res.status}`));
  return body;
}

async function callTool(name: string, args: Json): Promise<{ text: string; isError?: boolean }> {
  if (name === "remember") {
    const note = String(args.note ?? "").trim();
    const scope = args.scope === "workspace" ? "workspace" : "bot";
    if (!note) return { text: "remember needs a note.", isError: true };
    const r = await api(`/api/internal/remember`, {
      method: "POST",
      body: JSON.stringify({ fromBotId: BOT_ID, note, scope }),
    });
    if (r.error) return { text: `Couldn't save that note: ${r.error}`, isError: true };
    return { text: scope === "workspace" ? "Saved to shared workspace notes." : "Saved to this bot's notes." };
  }
  if (name === "recall") {
    const query = String(args.query ?? "").trim();
    const r = await api(`/api/internal/recall`, {
      method: "POST",
      body: JSON.stringify({ fromBotId: BOT_ID, ...(query ? { query } : {}) }),
    });
    if (r.error) return { text: `Couldn't read memory: ${r.error}`, isError: true };
    return { text: String(r.text ?? "(no memory yet)") };
  }
  return { text: `Unknown tool: ${name}`, isError: true };
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
        serverInfo: { name: "velarixbot-memory", version: "0.1.0" },
      });
      return;
    case "notifications/initialized":
    case "notifications/cancelled":
      return;
    case "ping":
      ok(id, {});
      return;
    case "tools/list":
      ok(id, { tools: TOOLS });
      return;
    case "tools/call": {
      const name = params.name as string;
      if (!TOOLS.some((t) => t.name === name)) return rpcErr(id, -32602, `Unknown tool: ${name}`);
      try {
        const { text, isError } = await callTool(name, (params.arguments ?? {}) as Json);
        textResult(id, text, isError);
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
