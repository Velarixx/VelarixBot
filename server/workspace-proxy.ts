// Workspace MCP proxy — CoS tools that are not bot-to-bot comms.
// Spawned next to agents/memory when the driver mounts agentsMcp.
//
//   web_search / fetch_page     public web (no in-app browser)
//   ask_choice / ask_secret     cards in chat; secret values never hit the transcript
//   create_routine / save_skill / run_skill
//   attach_to_chat              screenshot or a computer file into the thread
//   connect_app                 start a Composio OAuth card (never paste a token)
//
// Speaks raw JSON-RPC 2.0 over stdio. Token in env, never argv/logs.
import readline from "node:readline";

const HARNESS = process.env.OMB_HARNESS_URL ?? "http://127.0.0.1:8799";
const BOT_ID = process.env.OMB_BOT_ID ?? "";
const TOKEN = process.env.OMB_COMMS_TOKEN ?? "";
const DEPTH = Number(process.env.OMB_TURN_DEPTH ?? "0") || 0;

const TOOLS = [
  {
    name: "web_search",
    description: "Search the public web and return a short text summary. Use this instead of claiming you cannot browse.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "What to search for." } },
      required: ["query"],
    },
  },
  {
    name: "fetch_page",
    description: "Fetch a public http(s) page and return readable text. Not an in-app browser — no clicking or login.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", description: "Public http(s) URL." } },
      required: ["url"],
    },
  },
  {
    name: "ask_choice",
    description:
      "Ask the user a question with 2–5 one-tap options and wait for their answer. Use this instead of guessing preferences.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string" },
        choices: { type: "array", items: { type: "string" }, description: "2–5 short options." },
      },
      required: ["question", "choices"],
    },
  },
  {
    name: "ask_secret",
    description:
      "Ask the user for a secret (password, code) via a hidden card. The value is returned only to you — it never appears in the transcript, logs, or SSE. Never ask them to paste a token in chat.",
    inputSchema: {
      type: "object",
      properties: { prompt: { type: "string", description: "What you need, with enough context." } },
      required: ["prompt"],
    },
  },
  {
    name: "create_routine",
    description:
      "Schedule a prompt this bot will run later. Clock schedules are weekday-bounded (Mon–Fri) unless the user asks for every day. A github listener polls one owner/name repo for an explicit event list (GitHub token in App Settings). A slack listener polls one channel or DM (Composio Slack must be connected).",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        prompt: { type: "string", description: "What the bot should do when it fires." },
        time: { type: "string", description: "HH:MM 24h clock, for daily or weekdays." },
        every_day: { type: "boolean", description: "true = every calendar day; default weekdays only." },
        every_minutes: { type: "number", description: "Interval instead of a clock time." },
        listener: { type: "string", enum: ["github", "slack"], description: "Poll GitHub (token) or Slack (connected app) while the local harness service is running." },
        repo: { type: "string", description: "GitHub owner/name. One concrete repo — not all repos." },
        events: {
          type: "array",
          items: { type: "string" },
          description: "GitHub event allow-list: push, pull_request, issues, issue_comment, release, create, delete, fork, watch, pull_request_review, pull_request_review_comment. No wildcard.",
        },
        channel: { type: "string", description: "Slack channel or DM to poll (not the whole workspace)." },
        match: { type: "string", enum: ["mention", "keyword", "message"], description: "How a slack listener matches." },
        keyword: { type: "string", description: "Required when match is keyword." },
        skill_id: { type: "string" },
      },
      required: ["name", "prompt"],
    },
  },
  {
    name: "save_skill",
    description: "Save a reusable step recipe this bot can run later with run_skill.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        steps: { type: "string", description: "Ordered steps in markdown." },
      },
      required: ["name", "steps"],
    },
  },
  {
    name: "run_skill",
    description: "Load a saved skill's steps so you can follow them in this turn.",
    inputSchema: {
      type: "object",
      properties: { skill_id: { type: "string" } },
      required: ["skill_id"],
    },
  },
  {
    name: "attach_to_chat",
    description:
      "Put a screenshot of this bot's computer, or a file from it, into the chat thread so the user can see it.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["screenshot", "file"] },
        path: { type: "string", description: "Computer file path when kind=file." },
      },
      required: ["kind"],
    },
  },
  {
    name: "connect_app",
    description:
      "Start connecting a catalog app (github, slack, gmail, …) for this bot. Opens a user connect card — never ask them to paste a token in chat. Do not enable an app without this flow.",
    inputSchema: {
      type: "object",
      properties: { slug: { type: "string", description: "Catalog slug, e.g. github or slack." } },
      required: ["slug"],
    },
  },
  {
    name: "list_approved_secrets",
    description:
      "List Bitwarden Secrets Manager secret ids and names approved for this bot. Returns names only — never values. Empty means none are approved.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_approved_secret",
    description:
      "Return one Bitwarden secret value that the user explicitly approved for this bot. Never print the value in chat, logs, or command previews.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Secret id." },
        key: { type: "string", description: "Secret name, if id is unknown." },
      },
    },
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
  if (!TOOLS.some((t) => t.name === name)) return { text: `Unknown tool: ${name}`, isError: true };
  const r = await api(`/api/internal/workspace`, {
    method: "POST",
    body: JSON.stringify({ fromBotId: BOT_ID, tool: name, args, depth: DEPTH }),
  });
  if (r.error) return { text: String(r.error), isError: true };
  return { text: String(r.text ?? "ok") };
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
        serverInfo: { name: "velarixbot-workspace", version: "0.1.0" },
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
