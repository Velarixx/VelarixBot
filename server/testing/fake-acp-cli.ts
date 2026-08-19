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
//                   | stdin-close (closes its actual stdin pipe before it
//                     replies — the client's next write hits async EPIPE,
//                     which must be handled, never an unhandled crash)
//                   | session-auth-error (initialize/authenticate succeed,
//                     then session/new fails with ACP auth_required -32000
//                     and FAKE_ACP_SESSION_AUTH_MESSAGE — the gemini-cli
//                     signed-out shape, where auth methods are advertised
//                     unconditionally and the login gate is session/new)
//                   | session-new-error (session/new fails with a generic
//                     -32603, NOT auth_required — an auth probe riding the
//                     session gate must read this as inconclusive and fall
//                     back to its disk heuristic, never as signed-out)
//                   | split-utf8 (write a session/update whose JSON contains
//                     a multibyte character split across two raw stdout
//                     writes — the driver must reassemble the frame, not
//                     drop it)
//                   | ask-peer (spawn the injected "agents" MCP server from
//                     session/new's mcpServers, call list_bots + ask_bot on a
//                     peer, and reply with what the peer said — the comms e2e)
//                   | create-bot (call create_bot on the agents MCP and
//                     reply with the sidebar id the harness returned)
//   FAKE_ACP_DUMP   path to write {argv, env} as JSON, so a test can assert
//                   argv shape (agent/stdio flags) and env hygiene
//   FAKE_ACP_FIXTURE hermes-v0.20.4 selects the frames emitted by the tagged
//                   Hermes v0.20.4 ACP adapter: agentInfo + full capabilities
//                   on initialize, rich auth methods, and model/mode state on
//                   session/new and session/load. The strict Hermes CLI sets
//                   this only after validating its documented argv.
//   FAKE_ACP_AUTH_IDS  comma-separated authMethods that initialize
//                   advertises (default "cached_token"), each as `id` or
//                   `id:type` (e.g. "openai-codex,hermes-setup:terminal"
//                   models hermes' provider + terminal-setup pair) — lets
//                   harnesses that pick a different method run both the
//                   happy and the fail-closed path against the same fake.
//                   The methodId of the authenticate call lands in the dump
//                   as `authenticate`, so tests can pin which method a
//                   driver picked.
//   FAKE_ACP_CREATE_NAME  bot name for create-bot mode (default "Ops")
//   FAKE_ACP_SESSION_MODELS  comma-separated modelIds to advertise in the
//                   session/new AND session/load results as
//                   models.availableModels (first entry = currentModelId),
//                   REPLACING initialize's _meta.modelState — the gemini-cli
//                   shape, where the model truth arrives on the session
//                   result, not the handshake
//   FAKE_ACP_INIT_MODELS  comma-separated modelIds to advertise on
//                   initialize `_meta.modelState.availableModels` (legacy
//                   Grok-compatible shape). Ignored when
//                   FAKE_ACP_SESSION_MODELS is
//                   set. A lone currentModelId is the default — not a list.
//   FAKE_ACP_SESSION_AUTH_MESSAGE  the -32000 error text for
//                   session-auth-error mode (default "Authentication
//                   required.")
//   FAKE_ACP_PERMISSION_KIND  toolCall.kind for permission/credential asks
//                   (default "execute") — a scenario leg can pick "edit" so
//                   its always-allow rule never collides with another leg's
//                   workspace-global "shell" rule in the same harness home
//
// Keep this file dependency-free — it runs as a bare `node` subprocess.
import { spawn } from "node:child_process";
import { closeSync, readFileSync, writeFileSync } from "node:fs";

const mode = process.env.FAKE_ACP_MODE ?? "happy";
const hermesV0204 = process.env.FAKE_ACP_FIXTURE === "hermes-v0.20.4";
const AUTH_REQUIRED_CODE = -32000; // ACP's designated auth_required error code
// gemini-cli shape: the session result advertises the session's models
const sessionModelIds = (process.env.FAKE_ACP_SESSION_MODELS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const sessionModels = () =>
  sessionModelIds.length
    ? {
        models: {
          availableModels: sessionModelIds.map((id) => ({ modelId: id, name: id })),
          currentModelId: sessionModelIds[0],
        },
      }
    : {};
const hermesModes = () =>
  hermesV0204
    ? {
        modes: {
          availableModes: [
            { id: "default", name: "Default" },
            { id: "accept_edits", name: "Accept Edits" },
            { id: "dont_ask", name: "Don't Ask" },
          ],
          currentModeId: "default",
        },
      }
    : {};
const initModelIds = (process.env.FAKE_ACP_INIT_MODELS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
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
// generic one-shot generateText test surface (`cli exec -p …`)
if (argv[0] === "exec" && argv.includes("-p")) {
  if (dumpPath) writeDump({ execArgv: argv });
  console.log("User prefers concise replies. Last turn noted.");
  process.exit(0);
}
// generic pool-listing test surface (`cli auth list`); the driver's
// snapshot cache hint asks this BEFORE any file. Derived from
// FAKE_ACP_AUTH_IDS (agent-managed entries only — terminal methods are not
// credentials), so tests flip the pool through env, never through disk.
if (argv[0] === "auth" && argv[1] === "list") {
  const pool = (process.env.FAKE_ACP_AUTH_IDS ?? "cached_token")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((spec) => spec.split(":"))
    .filter(([id, type]) => id && id !== "hermes-setup" && type !== "terminal");
  if (pool.length === 0) console.log("No credentials configured.");
  for (const [id] of pool) console.log(`${id} (1 credential):\n  oauth device_code`);
  process.exit(0);
}
if (dumpPath) writeDump({});

const out = (obj: unknown) => process.stdout.write(JSON.stringify(obj) + "\n");
/** Write a JSON-RPC line as raw bytes, splitting a UTF-8 character across
 * two writes so a decoder that toString()s each Buffer independently
 * corrupts the frame. */
function outSplitUtf8(obj: unknown, marker: string) {
  const line = JSON.stringify(obj) + "\n";
  const bytes = Buffer.from(line, "utf8");
  const needle = Buffer.from(marker, "utf8");
  const idx = bytes.indexOf(needle);
  if (idx === -1 || needle.length < 2) {
    process.stdout.write(bytes);
    return;
  }
  process.stdout.write(bytes.subarray(0, idx + 1));
  process.stdout.write(bytes.subarray(idx + 1));
}
const result = (id: unknown, res: unknown) => out({ jsonrpc: "2.0", id, result: res });

function authMethods() {
  if (mode === "no-auth") return [];
  return (process.env.FAKE_ACP_AUTH_IDS ?? "cached_token")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((spec) => {
      const [id, type] = spec.split(":");
      if (!hermesV0204) return type ? { id, type } : { id };
      if (id === "hermes-setup" || type === "terminal") {
        return {
          id,
          name: "Configure Hermes provider",
          description:
            "Open Hermes' interactive model/provider setup in a terminal. Use this when Hermes has not been configured on this machine yet.",
          type: "terminal",
          args: ["--setup"],
        };
      }
      return {
        id,
        name: `${id} runtime credentials`,
        description: `Authenticate Hermes using the currently configured ${id} runtime credentials.`,
      };
    });
}

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

const SPLIT_UTF8_TEXT = "hello café 你好 €";

function playTurn() {
  const text = mode === "split-utf8" ? SPLIT_UTF8_TEXT : "hello from fake acp";
  const chunk = {
    jsonrpc: "2.0",
    method: "session/update",
    params: { update: { sessionUpdate: "agent_message_chunk", content: { text } } },
  };
  if (mode === "split-utf8") outSplitUtf8(chunk, "€");
  else out(chunk);
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
      const initializeResult = {
        protocolVersion: 1,
        authMethods: authMethods(),
        ...(hermesV0204 ? { agentInfo: { name: "hermes-agent", version: "0.20.4" } } : {}),
        agentCapabilities: hermesV0204
          ? {
              loadSession: true,
              promptCapabilities: { image: true },
              sessionCapabilities: { fork: {}, list: {}, resume: {} },
            }
          : { promptCapabilities: { image: mode !== "no-image" } },
        // gemini-cli and Hermes v0.20.4 carry model truth on the session
        // result. The generic/Grok fixture defaults to initialize currentModelId
        // only (not a catalog); FAKE_ACP_INIT_MODELS adds a legacy list.
        ...(!hermesV0204 && sessionModelIds.length
          ? {}
          : !hermesV0204
            ? {
              _meta: {
                modelState: {
                  currentModelId: initModelIds[0] ?? "fake-acp-model",
                  ...(initModelIds.length
                    ? { availableModels: initModelIds.map((id) => ({ modelId: id, name: id })) }
                    : {}),
                },
              },
              }
            : {}),
      };
      if (mode === "stdin-close") {
        if (process.platform === "win32") {
          // Node's Windows standard streams retain a libuv HANDLE after
          // destroy()/closeSync(0), so that POSIX-shaped fake leaves the
          // parent's pipe writable and cannot model closed stdin. Exit the
          // process to close the real read HANDLE, while a child that does
          // not inherit stdin relays the already-built response. The relay
          // briefly retains stdout so the driver receives initialize before
          // its child-close fallback settles the same failed lifecycle.
          const line = JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: initializeResult }) + "\n";
          const relayScript = `process.stdout.write(${JSON.stringify(line)}, () => setTimeout(() => {}, 500))`;
          const relay = spawn(process.execPath, ["-e", relayScript], {
            stdio: ["ignore", process.stdout, process.stderr],
            windowsHide: true,
          });
          relay.unref();
          process.exit(0);
        }
        // POSIX closes fd 0 for the process while stdout remains available,
        // so the response is causally after the pipe's read end closed.
        process.stdin.destroy();
        try {
          closeSync(0);
        } catch {
          /* already closed */
        }
        setInterval(() => {}, 1_000);
      }
      result(msg.id, initializeResult);
      break;
    }
    case "authenticate":
      writeDump({ authenticate: msg.params });
      if (mode === "auth-error") {
        out({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: "login expired — authenticate failed" } });
        break;
      }
      if (hermesV0204) {
        const methodId = msg.params?.methodId;
        const advertised = authMethods().some(
          (method) => method.id === methodId && method.type !== "terminal",
        );
        if (!advertised) {
          out({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "unsupported or unavailable auth method" } });
          break;
        }
      }
      result(msg.id, {});
      break;
    case "session/new": {
      const servers: McpEntry[] = Array.isArray(msg.params?.mcpServers) ? msg.params.mcpServers : [];
      agentsMcp = servers.find((s: any) => s?.name === "agents") ?? null;
      writeDump({ sessionNew: msg.params });
      if (mode === "session-auth-error") {
        // the gemini-cli signed-out shape: methods were advertised, an
        // authenticate even "succeeded" (it only selects a method) — the
        // real login gate is here
        out({
          jsonrpc: "2.0",
          id: msg.id,
          error: {
            code: AUTH_REQUIRED_CODE,
            message: process.env.FAKE_ACP_SESSION_AUTH_MESSAGE ?? "Authentication required.",
          },
        });
        break;
      }
      if (mode === "session-new-error") {
        // a NON-auth session failure — auth probes must read "inconclusive"
        out({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: "session/new failed (not an auth error)" } });
        break;
      }
      result(msg.id, { sessionId: "fake-acp-session", ...sessionModels(), ...hermesModes() });
      break;
    }
    case "session/load": {
      const servers: McpEntry[] = Array.isArray(msg.params?.mcpServers) ? msg.params.mcpServers : [];
      agentsMcp = servers.find((s: any) => s?.name === "agents") ?? agentsMcp;
      writeDump({ sessionLoad: msg.params });
      result(msg.id, { ...sessionModels(), ...hermesModes() });
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
        result(
          msg.id,
          hermesV0204
            ? { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } }
            : { stopReason: "end_turn", _meta: { inputTokens: 10, outputTokens: 5 } },
        );
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
            options: hermesV0204
              ? [
                  { optionId: "allow_once", kind: "allow_once", name: "Allow once" },
                  { optionId: "allow_session", kind: "allow_always", name: "Allow for session" },
                  { optionId: "allow_always", kind: "allow_always", name: "Allow always" },
                  { optionId: "deny", kind: "reject_once", name: "Deny" },
                ]
              : [
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
