// Agent-to-agent comms MCP proxy — spawned as an MCP server inside a bot's
// agent process (via the "agents" integration). Exposes tools that let
// one bot talk to another or create a real sidebar bot, routed back through
// the harness so the harness stays the single owner of turns, permissions,
// and recursion limits:
//
//   list_bots()            → the other bots in this workspace + their status
//   ask_bot(bot_id, msg)   → send msg to that bot, wait, return its reply
//   delegate_bot(bot_id, msg, reason?) → queue a handoff; returns immediately
//   create_bot(...)        → create a real sidebar bot (name/title/description)
//   delete_bot(bot_id)     → remove a sidebar bot (refuses the last bot)
//   update_bot(bot_id, …)  → rename or change title/description (persona)
//
// Speaks raw JSON-RPC 2.0 over stdio (no MCP SDK — house style, matches
// computer-proxy / permission-proxy). All state comes from env, injected by
// the harness when it builds the integration:
//   OMB_HARNESS_URL  base URL of the harness (http://127.0.0.1:8799)
//   OMB_BOT_ID       the calling bot's id (excluded from list_bots; sender)
//   OMB_COMMS_TOKEN  shared secret for the localhost-only internal endpoints
//   OMB_TURN_DEPTH   this turn's comms depth (the harness refuses recursion)
import readline from "node:readline";

const HARNESS = process.env.OMB_HARNESS_URL ?? "http://127.0.0.1:8799";
const BOT_ID = process.env.OMB_BOT_ID ?? "";
const TOKEN = process.env.OMB_COMMS_TOKEN ?? "";
const DEPTH = Number(process.env.OMB_TURN_DEPTH ?? "0") || 0;
const VISITED = process.env.OMB_VISITED ?? "";
const GROUP_THREAD_ID = process.env.OMB_GROUP_THREAD_ID ?? "";

const TOOLS = [
  {
    name: "list_bots",
    description:
      "List the other bots (agents) in this VelarixBot workspace you can message, with their model and whether they're busy. Call this before ask_bot or delegate_bot to discover who's available.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: "ask_bot",
    description:
      "Send a message to another bot in this workspace and wait for its reply. Use it when you need the teammate's answer before you continue. The other bot runs a full turn under its own model and permissions; the reply is returned to you as text and stays in this transcript — do not ask the user to relay it. If that bot is busy, the ask is queued until it finishes. To hand work off without waiting, use delegate_bot.",
    inputSchema: {
      type: "object",
      properties: {
        bot_id: { type: "string", description: "The target bot's id (from list_bots)." },
        message: { type: "string", description: "What to say / ask the bot." },
      },
      required: ["bot_id", "message"],
    },
  },
  {
    name: "delegate_bot",
    description:
      "Hand a task to another bot asynchronously: returns immediately with \"Delegation queued.\" and the peer runs after your current turn finishes. Use this when you want to keep working or hand off work and do not wait. You do not receive the peer's reply inline — the user sees it on the A ⇄ B DM and the peer's own turn.",
    inputSchema: {
      type: "object",
      properties: {
        bot_id: { type: "string", description: "The target bot's id (from list_bots)." },
        message: { type: "string", description: "What the peer should do / answer." },
        reason: { type: "string", description: "Optional one-line reason for the delegation (shown to the user as a chip)." },
      },
      required: ["bot_id", "message"],
    },
  },
  {
    name: "create_bot",
    description:
      "Create a real VelarixBot bot that appears in the sidebar. Use this when asked to create bots or specialists. Never invent Codex/conversation-only sub-agents — they do not show in the workspace. After creating, list_bots will include the new bot and ask_bot can message it by id.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Display name in the sidebar (required)." },
        title: { type: "string", description: "Short role title, e.g. Engineering Reviewer." },
        description: { type: "string", description: "What this bot is for — becomes its persona." },
        model: { type: "string", description: "Optional model id (e.g. gpt-5.6-terra). Omit to use the workspace default." },
      },
      required: ["name", "title", "description"],
    },
  },
  {
    name: "delete_bot",
    description:
      "Remove a VelarixBot sidebar bot by id (from list_bots). Use this when asked to delete or remove a bot. Refuses to delete the last bot in the workspace. After deleting, list_bots will no longer include it.",
    inputSchema: {
      type: "object",
      properties: {
        bot_id: { type: "string", description: "The target bot's id (from list_bots)." },
      },
      required: ["bot_id"],
    },
  },
  {
    name: "update_bot",
    description:
      "Rename a sidebar bot or change its title/description (persona) or its Always-allow permissions setting. bot_id comes from list_bots. Omit fields you are not changing.",
    inputSchema: {
      type: "object",
      properties: {
        bot_id: { type: "string", description: "The target bot's id (from list_bots)." },
        name: { type: "string" },
        title: { type: "string" },
        description: { type: "string", description: "Persona / about text." },
        always_allow: {
          type: "boolean",
          description:
            "Bot Settings → Permissions → Always allow for THAT bot only: routine permission asks auto-resolve without a card. Credential/sign-in asks still ask the user. Never workspace-wide.",
        },
      },
      required: ["bot_id"],
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
  if (name === "list_bots") {
    const r = await api(`/api/internal/agents?self=${encodeURIComponent(BOT_ID)}`);
    const bots = (r.bots as Array<Json>) ?? [];
    if (!bots.length) return { text: "No other bots in this workspace yet." };
    const lines = bots.map((b) => `- ${b.name} (id: ${b.id}, model: ${b.model}${b.busy ? ", busy" : ""})`);
    return { text: `Other bots you can message with ask_bot:\n${lines.join("\n")}` };
  }
  if (name === "ask_bot") {
    const toBotId = String(args.bot_id ?? "").trim();
    const message = String(args.message ?? "").trim();
    if (!toBotId || !message) return { text: "ask_bot needs bot_id and message.", isError: true };
    const r = await api(`/api/internal/ask-bot`, {
      method: "POST",
      body: JSON.stringify({
        fromBotId: BOT_ID,
        toBotId,
        message,
        depth: DEPTH,
        visited: VISITED,
        ...(GROUP_THREAD_ID ? { groupThreadId: GROUP_THREAD_ID } : {}),
      }),
    });
    if (r.busy) return { text: `That bot is busy — waiting in line, then I'll deliver the ask.` };
    if (r.error) return { text: `Couldn't reach that bot: ${r.error}`, isError: true };
    return { text: `${r.botName ?? "Bot"} replied:\n${r.text ?? "(no reply)"}` };
  }
  if (name === "delegate_bot") {
    const toBotId = String(args.bot_id ?? "").trim();
    const message = String(args.message ?? "").trim();
    const reason = typeof args.reason === "string" ? args.reason.trim() : "";
    if (!toBotId || !message) return { text: "delegate_bot needs bot_id and message.", isError: true };
    const body: Record<string, unknown> = {
      fromBotId: BOT_ID,
      toBotId,
      message,
      depth: DEPTH,
    };
    if (reason) body.reason = reason;
    const r = await api(`/api/internal/delegate-bot`, { method: "POST", body: JSON.stringify(body) });
    if (r.error) return { text: `Couldn't queue the delegation: ${r.error}`, isError: true };
    return { text: typeof r.message === "string" ? r.message : "Delegation queued." };
  }
  if (name === "create_bot") {
    const botName = String(args.name ?? "").trim();
    const title = String(args.title ?? "").trim();
    const description = String(args.description ?? "").trim();
    const model = String(args.model ?? "").trim();
    if (!botName || !title || !description) {
      return { text: "create_bot needs name, title, and description.", isError: true };
    }
    const r = await api(`/api/internal/create-bot`, {
      method: "POST",
      body: JSON.stringify({
        fromBotId: BOT_ID,
        name: botName,
        title,
        description,
        ...(model ? { model } : {}),
        depth: DEPTH,
      }),
    });
    if (r.error) return { text: `Couldn't create that bot: ${r.error}`, isError: true };
    const created = (r.bot as Json) ?? {};
    return {
      text: `Created sidebar bot ${created.name ?? botName} (id: ${created.id}, model: ${created.model ?? "default"}). It is now in the VelarixBot sidebar. Message it with ask_bot using that id.`,
    };
  }
  if (name === "delete_bot") {
    const targetId = String(args.bot_id ?? "").trim();
    if (!targetId) return { text: "delete_bot needs bot_id.", isError: true };
    const r = await api(`/api/internal/delete-bot`, {
      method: "POST",
      body: JSON.stringify({
        fromBotId: BOT_ID,
        bot_id: targetId,
        depth: DEPTH,
      }),
    });
    if (r.error) return { text: `Couldn't delete that bot: ${r.error}`, isError: true };
    return {
      text: `Removed sidebar bot ${r.name ?? targetId} (id: ${r.id ?? targetId}). It is no longer in the VelarixBot sidebar.`,
    };
  }
  if (name === "update_bot") {
    const targetId = String(args.bot_id ?? "").trim();
    if (!targetId) return { text: "update_bot needs bot_id.", isError: true };
    const namePatch = String(args.name ?? "").trim();
    const titlePatch = typeof args.title === "string" ? args.title : undefined;
    const descriptionPatch = typeof args.description === "string" ? args.description : undefined;
    const alwaysAllowPatch = typeof args.always_allow === "boolean" ? args.always_allow : undefined;
    if (!namePatch && titlePatch === undefined && descriptionPatch === undefined && alwaysAllowPatch === undefined) {
      return { text: "update_bot needs name, title, description, or always_allow.", isError: true };
    }
    const r = await api(`/api/internal/update-bot`, {
      method: "POST",
      body: JSON.stringify({
        fromBotId: BOT_ID,
        bot_id: targetId,
        ...(namePatch ? { name: namePatch } : {}),
        ...(titlePatch !== undefined ? { title: titlePatch } : {}),
        ...(descriptionPatch !== undefined ? { description: descriptionPatch } : {}),
        ...(alwaysAllowPatch !== undefined ? { always_allow: alwaysAllowPatch } : {}),
        depth: DEPTH,
      }),
    });
    if (r.error) return { text: `Couldn't update that bot: ${r.error}`, isError: true };
    const alwaysAllowNote =
      alwaysAllowPatch === undefined ? "" : ` Always allow is now ${r.always_allow === true ? "on" : "off"} for that bot.`;
    return {
      text: `Updated sidebar bot ${r.name ?? targetId} (id: ${r.id ?? targetId}).${alwaysAllowNote}`,
    };
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
        serverInfo: { name: "opengrokbot-agents", version: "0.1.0" },
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
