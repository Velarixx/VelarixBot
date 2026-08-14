#!/usr/bin/env node
// Fake of an ACP (Agent Client Protocol) CLI's stdio surface, for driver
// tests of acp/core.ts + its harness shims (grok, gemini). Speaks JSON-RPC
// 2.0 over stdin/stdout: answers initialize / authenticate / session/new /
// session/prompt, and streams session/update notifications for a scripted
// turn. Failure modes mirror how real ACP agents misbehave:
//
//   FAKE_ACP_MODE   happy (default) | exit-early | hang | no-auth | permission
//                   | credential (permission ask that is a sign-in handoff)
//                   | malformed (garbage lines mid-protocol, then a normal
//                     completion — the driver must skip them)
//                   | unknown-event (an unknown notification method and an
//                     unknown sessionUpdate kind — the driver must ignore both)
//                   | unknown-request (a server→client request with an
//                     unknown method — the driver must reply with a JSON-RPC
//                     error, never a fabricated approval; the reply lands in
//                     the dump as unknownRequestReply)
//                   | crash-mid-turn (one chunk, then exit 9 without the
//                     prompt result — the restart-mid-turn shape)
//                   | auth-error (authenticate RPC errors — a dead login)
//                   | expired-token (authenticate succeeds, then
//                     session/prompt fails with ACP auth_required -32000 —
//                     the token-expired-mid-session shape)
//                   | stdin-close (replies to initialize but closes its
//                     stdin first, then stays alive — the client's next
//                     write hits a closed pipe: async EPIPE, which must be
//                     handled, never an unhandled 'error' server crash)
//                   | ask-peer (spawn the injected "agents" MCP server from
//                     session/new's mcpServers, call list_bots + ask_bot on a
//                     peer, and reply with what the peer said — the comms e2e)
//                   | create-bot (call create_bot on the agents MCP and
//                     reply with the sidebar id the harness returned)
//   FAKE_ACP_DUMP   path to write {argv, env} as JSON, so a test can assert
//                   argv shape (agent/stdio flags) and env hygiene
//   FAKE_ACP_AUTH_IDS  comma-separated authMethods ids that initialize
//                   advertises (default "cached_token") — lets harnesses
//                   that pick a different method (hermes → chatgpt-oauth)
//                   run both the happy and the fail-closed path against the
//                   same fake
//   FAKE_ACP_CREATE_NAME  bot name for create-bot mode (default "Ops")
//   FAKE_ACP_PERMISSION_KIND  toolCall.kind for permission/credential asks
//                   (default "execute") — a scenario leg can pick "edit" so
//                   its always-allow rule never collides with another leg's
//                   workspace-global "shell" rule in the same harness home
//
// Keep this file dependency-free — it runs as a bare `node` subprocess.
import { spawn } from "node:child_process";
import { closeSync, readFileSync, writeFileSync } from "node:fs";

const mode = process.env.FAKE_ACP_MODE ?? "happy";
const AUTH_REQUIRED_CODE = -32000; // ACP's designated auth_required error code
const argv = process.argv.slice(2);
const dumpPath = process.env.FAKE_ACP_DUMP;
function writeDump(patch: Record<string, unknown>) {
  if (!dumpPath) return;
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(readFileSync(dumpPath, "utf8"));
  } catch {
    existing = { argv, env: process.env };
  }
  writeFileSync(dumpPath, JSON.stringify({ ...existing, argv, env: process.env, ...patch }, null, 2));
}
if (argv.includes("--version")) {
  console.log("fake-acp 1.0.0");
  process.exit(0);
}
// one-shot generateText surface (`cli exec -p …`) — hermes-style
if (argv[0] === "exec" && argv.includes("-p")) {
  if (dumpPath) writeDump({ execArgv: argv });
  console.log("User prefers concise replies. Last turn noted.");
  process.exit(0);
}
if (dumpPath) writeDump({});

const out = (obj: unknown) => process.stdout.write(JSON.stringify(obj) + "\n");
const result = (id: unknown, res: unknown) => out({ jsonrpc: "2.0", id, result: res });

// pending server→client permission request id → resolver
let pendingPermissionId: number | null = null;
let onPermissionAnswered: ((reply?: any) => void) | null = null;

// hang mode: the prompt left open, so session/cancel can resolve it the way
// real ACP agents do (stopReason "cancelled") instead of leaving the client
// to time out
let hungPromptId: unknown = null;

// ask-peer mode: the "agents" MCP server entry from session/new's mcpServers
type McpEntry = { command: string; args?: string[]; env?: Array<{ name: string; value: string }> };
let agentsMcp: McpEntry | null = null;

/** Minimal one-shot MCP stdio client: initialize, call each tool in
 * sequence, return the text of the last result. Dependency-free. */
function driveMcp(entry: McpEntry, calls: Array<{ name: string; args: (prev: string) => unknown }>): Promise<string> {
  return new Promise((resolve, reject) => {
    const env: Record<string, string> = { ...(process.env as Record<string, string>) };
    for (const { name, value } of entry.env ?? []) env[name] = value;
    const child = spawn(entry.command, entry.args ?? [], { env, stdio: ["pipe", "pipe", "inherit"] });
    child.on("error", reject);
    const timer = setTimeout(() => (child.kill(), reject(new Error("mcp timeout"))), 60_000);
    let step = -1; // -1 = initialize in flight
    let last = "";
    const write = (obj: unknown) => child.stdin.write(JSON.stringify(obj) + "\n");
    const next = () => {
      step += 1;
      if (step >= calls.length) {
        clearTimeout(timer);
        child.kill();
        return resolve(last);
      }
      const call = calls[step];
      write({ jsonrpc: "2.0", id: step + 2, method: "tools/call", params: { name: call.name, arguments: call.args(last) } });
    };
    let buf = "";
    child.stdout.on("data", (c) => {
      buf += c;
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === undefined) continue;
        if (step === -1) {
          write({ jsonrpc: "2.0", method: "notifications/initialized" });
          next();
          continue;
        }
        last = String(msg.result?.content?.[0]?.text ?? "");
        next();
      }
    });
    write({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } });
  });
}

function playTurn() {
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "hello from fake acp" } } } });
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call", toolCallId: "tc-1", title: "run" } } });
  out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "tool_call_update", toolCallId: "tc-1", status: "completed" } } });
}

let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    handle(msg);
  }
});

function handle(msg: any) {
  // client's response to our permission request
  if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined) && msg.id === pendingPermissionId) {
    pendingPermissionId = null;
    onPermissionAnswered?.(msg);
    return;
  }
  if (!msg.method) return;

  switch (msg.method) {
    case "initialize": {
      if (mode === "exit-early") {
        process.stderr.write("fake-acp: simulated crash before result\n");
        process.exit(3);
      }
      if (mode === "stdin-close") {
        // close our read end BEFORE replying: the client's follow-up write
        // is then causally after the close and must surface as a handled
        // stdin 'error' (EPIPE), never an unhandled crash. Stay alive so
        // the failure is the write itself, not our exit. destroy() alone
        // is not enough — libuv holds a duplicate — closing fd 0 is what
        // actually breaks the pipe.
        process.stdin.destroy();
        try {
          closeSync(0);
        } catch {
          /* already closed */
        }
        setInterval(() => {}, 1_000);
      }
      const authIds = (process.env.FAKE_ACP_AUTH_IDS ?? "cached_token")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const authMethods = mode === "no-auth" ? [] : authIds.map((id) => ({ id }));
      result(msg.id, {
        protocolVersion: 1,
        authMethods,
        agentCapabilities: { promptCapabilities: { image: mode !== "no-image" } },
        _meta: { modelState: { currentModelId: "fake-acp-model" } },
      });
      break;
    }
    case "authenticate":
      if (mode === "auth-error") {
        out({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: "login expired — authenticate failed" } });
        break;
      }
      result(msg.id, {});
      break;
    case "session/new": {
      const servers: McpEntry[] = Array.isArray(msg.params?.mcpServers) ? msg.params.mcpServers : [];
      agentsMcp = servers.find((s: any) => s?.name === "agents") ?? null;
      writeDump({ sessionNew: msg.params });
      result(msg.id, { sessionId: "fake-acp-session" });
      break;
    }
    case "session/load": {
      const servers: McpEntry[] = Array.isArray(msg.params?.mcpServers) ? msg.params.mcpServers : [];
      agentsMcp = servers.find((s: any) => s?.name === "agents") ?? agentsMcp;
      writeDump({ sessionLoad: msg.params });
      result(msg.id, {});
      break;
    }
    case "session/prompt": {
      writeDump({ sessionPrompt: msg.params });
      if (mode === "expired-token") {
        // authenticate said yes earlier; the token died between then and the
        // prompt. Must settle the turn as auth_required — never hang.
        out({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: AUTH_REQUIRED_CODE, message: "authentication required — token expired" },
        });
        return;
      }
      if (mode === "hang") {
        // never resolve the prompt on our own — lets tests exercise
        // interrupt; session/cancel resolves it as cancelled (see below)
        hungPromptId = msg.id;
        setInterval(() => {}, 1_000);
        return;
      }
      if (mode === "crash-mid-turn") {
        out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "partial " } } } });
        process.stderr.write("fake-acp: crashing mid-turn\n");
        process.exit(9);
      }
      if (mode === "malformed") {
        process.stdout.write("this is not json\n{broken\n");
      }
      const complete = () =>
        result(msg.id, { stopReason: "end_turn", _meta: { inputTokens: 10, outputTokens: 5 } });
      if (mode === "ask-peer" && agentsMcp) {
        const depth = Number(agentsMcp.env?.find((e) => e.name === "OMB_TURN_DEPTH")?.value ?? "0") || 0;
        // Originator (depth 0) asks a peer. A comms-invoked turn still has
        // agents MCP at depth 1 (MAX_COMMS_DEPTH=2) — don't recurse here;
        // play the happy-path reply so the e2e can assert the peer's text.
        if (depth === 0) {
          void driveMcp(agentsMcp, [
            { name: "list_bots", args: () => ({}) },
            {
              name: "ask_bot",
              args: (list) => ({ bot_id: /id: ([\w-]+)/.exec(list)?.[1] ?? "", message: "ping from fake" }),
            },
          ])
            .then((reply) => {
              out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `peer says: ${reply}` } } } });
              complete();
            })
            .catch((e) => {
              out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `peer error: ${(e as Error).message}` } } } });
              complete();
            });
          return;
        }
      }
      if (mode === "create-bot" && agentsMcp) {
        const depth = Number(agentsMcp.env?.find((e) => e.name === "OMB_TURN_DEPTH")?.value ?? "0") || 0;
        if (depth === 0) {
          const createName = process.env.FAKE_ACP_CREATE_NAME ?? "Ops";
          void driveMcp(agentsMcp, [
            {
              name: "create_bot",
              args: () => ({ name: createName, title: `${createName} specialist`, description: "Handles ops" }),
            },
          ])
            .then((reply) => {
              out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `created: ${reply}` } } } });
              complete();
            })
            .catch((e) => {
              out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: `create error: ${(e as Error).message}` } } } });
              complete();
            });
          return;
        }
      }
      playTurn();
      if (mode === "unknown-event") {
        // a vendor side-channel notification and a future sessionUpdate
        // kind — the driver must ignore both, not crash the turn
        out({ jsonrpc: "2.0", method: "vendor/heartbeat", params: { ok: true } });
        out({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "sparkline_report", spark: [1, 2, 3] } } });
      }
      if (mode === "unknown-request") {
        // a server→client request the client cannot know — it must answer
        // with a JSON-RPC error (never a fabricated approval) or we'd hang
        pendingPermissionId = 9002;
        onPermissionAnswered = (reply) => {
          writeDump({ unknownRequestReply: { result: reply?.result ?? null, error: reply?.error ?? null } });
          complete();
        };
        out({ jsonrpc: "2.0", id: pendingPermissionId, method: "session/mystery_probe", params: { probe: true } });
        return;
      }
      if (mode === "permission" || mode === "credential") {
        // ask the client to approve a tool, then complete once answered
        pendingPermissionId = 9001;
        onPermissionAnswered = complete;
        const signIn = mode === "credential";
        out({
          jsonrpc: "2.0",
          id: pendingPermissionId,
          method: "session/request_permission",
          params: {
            toolCall: {
              kind: process.env.FAKE_ACP_PERMISSION_KIND ?? "execute",
              rawInput: { command: signIn ? "Sign in to GitHub. password: hunter2-never-leak" : "echo hi" },
              title: signIn ? "Sign in to GitHub" : "echo hi",
            },
            options: [
              { optionId: "allow-once", kind: "allow_once" },
              { optionId: "reject", kind: "reject_once" },
            ],
          },
        });
        return;
      }
      complete();
      break;
    }
    case "session/cancel":
      // the interrupted prompt resolves as cancelled, like real ACP agents
      if (hungPromptId !== null) {
        result(hungPromptId, { stopReason: "cancelled" });
        hungPromptId = null;
      }
      break;
    default:
      if (msg.id !== undefined) out({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
  }
}
