#!/usr/bin/env node
// Fake of the codex CLI's `app-server` JSON-RPC surface, for driver
// tests. Speaks newline-delimited JSON-RPC on stdio: answers the
// initialize/thread/turn handshake, then plays a scripted turn. Like the
// real app-server, it never exits on its own — the driver kills it.
//
// Also answers `codex --version` and `codex debug models [--bundled]` so
// catalog probes at create/snapshot don't hang. Dump JSON matches the
// real CLI: `{ models: [{ slug, display_name, visibility }] }`.
//
//   FAKE_CODEX_MODE   happy (default) | approval | resume | stream | no-models
//                     | user-input (conversational A/B/C requestUserInput)
//                     | user-input-approval (requestUserInput Accept/Decline)
//                     | credential (requestUserInput sign-in handoff)
//                     | elicitation (mcpServer/elicitation/request — current
//                       CLI MCP-tool approval; reply is {action}, not {decision})
//                     | permissions (item/permissions/requestApproval)
//                     | command-approval (item/commandExecution/requestApproval)
//                     | unknown-method (unsupported server→client method)
//                     | hang (turn/start acknowledged, item/started, then
//                       nothing — lets tests exercise interrupt/stopAll)
//                     | malformed (garbage lines mid-protocol, then a
//                       normal completion — the driver must skip them)
//                     | unknown-event (notifications a future app-server
//                       might add — the driver must ignore them)
//                     | crash-mid-turn (item/started, then exit 9 without
//                       turn/completed — the restart-mid-turn shape)
//                     | exit-zero (assistant text, then process.exit(0)
//                       without turn/completed)
//                     | exit-early (crash with code 3 before a turn)
//                     | not-app-server (an outdated/shadowed codex: answers
//                       --version and debug models but treats "app-server"
//                       as noise — plain text, usage on stderr, exit 0 with
//                       ZERO protocol traffic; the issue #9 / rc.12 shape)
//                     | stdin-close (replies to initialize but closes its
//                       stdin first, then stays alive — the client's next
//                       write hits a closed pipe: async EPIPE, which must be
//                       handled, never an unhandled 'error' server crash)
//                     | refresh-token (JSON-RPC error on turn/start with the
//                       real CLI "refresh token was already used" sentence)
//   FAKE_CODEX_AUTH   in (default) | out | stale | unsupported |
//                     inherited-api-key — what `login status` reports.
//                     Bare `login` (OAuth) is a hard fail so a driver that
//                     spawned `codex login` via a hidden console cannot hide.
//   FAKE_CODEX_DUMP   path to write {argv, env, calls, decision,
//                     threadStartConfig, threadResumeConfig} as JSON
//
// Keep this file dependency-free — it runs as a bare `node` subprocess.
import { closeSync, writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const mode = process.env.FAKE_CODEX_MODE ?? "happy";
const calls: Array<{ method: string; params: unknown }> = [];
let decision: unknown = null;
let threadStartConfig: unknown = null;
let threadResumeConfig: unknown = null;

const out = (obj: unknown) => process.stdout.write(JSON.stringify(obj) + "\n");
const notify = (method: string, params: unknown) => out({ jsonrpc: "2.0", method, params });

const dump = () => {
  if (process.env.FAKE_CODEX_DUMP) {
    writeFileSync(
      process.env.FAKE_CODEX_DUMP,
      JSON.stringify(
        { argv, env: process.env, cwd: process.cwd(), calls, decision, threadStartConfig, threadResumeConfig },
        null,
        2,
      ),
    );
  }
};

if (argv.includes("--version")) {
  process.stdout.write("fake-codex 0.144.4\n");
  process.exit(0);
}

// Snapshot probes: answer on argv alone and exit without reading stdin.
// Strict: only `login status`. Bare `login` is the OAuth flow — refuse it
// so a driver that spawned login in a hidden console fails the suite.
if (argv[0] === "login") {
  if (argv[1] !== "status" || argv.length !== 2) {
    process.stderr.write("error: expected `login status` — do not spawn `codex login`\n");
    process.exit(1);
  }
  const auth = process.env.FAKE_CODEX_AUTH ?? "in";
  if (auth === "unsupported") {
    process.stderr.write("error: unknown command 'login'\n");
    process.exit(1);
  }
  if (auth === "stale") {
    process.stderr.write(
      "Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.\n",
    );
    process.exit(1);
  }
  if (auth === "out") {
    process.stderr.write("Not logged in\n");
    process.exit(1);
  }
  const loggedIn = auth === "in" || (auth === "inherited-api-key" && Boolean(process.env.OPENAI_API_KEY));
  if (!loggedIn) {
    process.stderr.write("Not logged in\n");
    process.exit(1);
  }
  process.stderr.write("Logged in using ChatGPT\n");
  process.exit(0);
}

if (argv[0] === "debug" && argv[1] === "models") {
  dump();
  if (mode === "no-models") {
    process.stderr.write("fake-codex: no model catalog\n");
    process.exit(1);
  }
  // Wider than the old hardcoded Sol/Terra/5.4 set. hide+gpt stays;
  // Auto Review is internal and the driver must drop it.
  process.stdout.write(
    JSON.stringify({
      models: [
        { slug: "gpt-5.6-sol", display_name: "GPT-5.6-Sol", visibility: "list" },
        { slug: "gpt-5.6-terra", display_name: "GPT-5.6-Terra", visibility: "list" },
        { slug: "gpt-5.6-luna", display_name: "GPT-5.6-Luna", visibility: "list" },
        { slug: "gpt-5.5", display_name: "GPT-5.5", visibility: "list" },
        { slug: "gpt-5.4", display_name: "GPT-5.4", visibility: "hide" },
        { slug: "gpt-5.4-mini", display_name: "GPT-5.4-Mini", visibility: "hide" },
        { slug: "codex-auto-review", display_name: "Codex Auto Review", visibility: "hide" },
      ],
    }) + "\n",
  );
  process.exit(0);
}

if (mode === "not-app-server") {
  // never reads stdin, never a JSON-RPC byte — exits 0 like an old CLI that
  // shrugged at an unknown subcommand
  process.stdout.write("app-server: unknown command — starting interactive prompt\n");
  process.stderr.write("usage: codex [exec|apply|login] ...\n");
  process.exit(0);
}

const finishTurn = () => {
  notify("item/completed", { item: { id: "i1", type: "commandExecution", status: "completed" } });
  if (mode === "stream") {
    // token deltas, then the whole message — the driver must not double-emit
    notify("item/agentMessage/delta", { itemId: "m1", delta: "done from " });
    notify("item/agentMessage/delta", { itemId: "m1", delta: "fake codex" });
  }
  notify("item/completed", { item: { id: "m1", type: "agentMessage", text: "done from fake codex" } });
  notify("thread/tokenUsage/updated", { tokenUsage: { total: { inputTokens: 7, outputTokens: 3 } } });
  dump();
  notify("turn/completed", { turn: { status: "completed" } });
};

let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk;
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

    // response to our own server->client request (approval decision)
    if (msg.id === 100 && (msg.result !== undefined || msg.error !== undefined)) {
      decision = msg.result ?? { error: msg.error };
      finishTurn();
      continue;
    }

    if (msg.method) calls.push({ method: msg.method, params: msg.params ?? null });

    switch (msg.method) {
      case "initialize":
        if (mode === "exit-early") {
          process.stderr.write("fake-codex: simulated crash before result\n");
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
        }
        out({ jsonrpc: "2.0", id: msg.id, result: { ok: true } });
        break;
      case "thread/resume":
        threadResumeConfig = msg.params?.config ?? null;
        if (mode === "resume") {
          out({ jsonrpc: "2.0", id: msg.id, result: { thread: { id: msg.params?.threadId } } });
        } else {
          out({ jsonrpc: "2.0", id: msg.id, error: { code: -1, message: "no such thread" } });
        }
        break;
      case "thread/start":
        threadStartConfig = msg.params?.config ?? null;
        out({ jsonrpc: "2.0", id: msg.id, result: { thread: { id: "codex-thread-1" }, model: "fake-codex-model" } });
        break;
      case "turn/start":
        if (mode === "refresh-token") {
          out({
            jsonrpc: "2.0",
            id: msg.id,
            error: {
              code: -32603,
              message:
                "Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.",
            },
          });
          break;
        }
        out({ jsonrpc: "2.0", id: msg.id, result: { ok: true } });
        notify("item/started", { item: { id: "i1", type: "commandExecution", command: "ls -la" } });
        if (mode === "approval") {
          out({ jsonrpc: "2.0", id: 100, method: "execCommandApproval", params: { command: "rm -rf scratch" } });
          // turn continues from the approval response handler above
        } else if (mode === "command-approval") {
          out({
            jsonrpc: "2.0",
            id: 100,
            method: "item/commandExecution/requestApproval",
            params: { command: "rm -rf scratch", itemId: "i1", threadId: "codex-thread-1", turnId: "turn-1", startedAtMs: 0 },
          });
        } else if (mode === "elicitation") {
          out({
            jsonrpc: "2.0",
            id: 100,
            method: "mcpServer/elicitation/request",
            params: {
              threadId: "codex-thread-1",
              turnId: "turn-1",
              serverName: "agents",
              mode: "form",
              message: 'Allow the agents MCP server to run tool "list_bots"?',
              _meta: { codex_approval_kind: "mcp_tool_call", persist: ["session", "always"] },
              requestedSchema: { type: "object", properties: {} },
            },
          });
        } else if (mode === "permissions") {
          out({
            jsonrpc: "2.0",
            id: 100,
            method: "item/permissions/requestApproval",
            params: {
              threadId: "codex-thread-1",
              turnId: "turn-1",
              itemId: "i1",
              startedAtMs: 0,
              cwd: process.cwd(),
              reason: "Need network to fetch docs",
              permissions: { network: { enabled: true } },
            },
          });
        } else if (mode === "unknown-method") {
          out({ jsonrpc: "2.0", id: 100, method: "item/tool/call", params: { name: "surprise" } });
        } else if (mode === "user-input") {
          out({
            jsonrpc: "2.0",
            id: 100,
            method: "item/tool/requestUserInput",
            params: {
              questions: [
                {
                  id: "next",
                  header: "Next",
                  question: "What would you like to do?",
                  options: [
                    { value: "a", label: "Create a Chief of Staff" },
                    { value: "b", label: "Explore the workspace" },
                    { value: "c", label: "Something else" },
                  ],
                },
              ],
            },
          });
        } else if (mode === "user-input-approval") {
          out({
            jsonrpc: "2.0",
            id: 100,
            method: "item/tool/requestUserInput",
            params: {
              questions: [
                {
                  id: "mcp_approve",
                  header: "Approve",
                  question: "Allow the agents create_bot tool?",
                  options: [
                    { value: "accept", label: "Accept" },
                    { value: "decline", label: "Decline" },
                    { value: "cancel", label: "Cancel" },
                  ],
                },
              ],
            },
          });
        } else if (mode === "credential") {
          out({
            jsonrpc: "2.0",
            id: 100,
            method: "item/tool/requestUserInput",
            params: {
              questions: [
                {
                  id: "signin",
                  header: "Sign in",
                  question: "Sign in to GitHub to continue. password: hunter2-never-leak",
                  options: [{ value: "done", label: "I've signed in — continue" }],
                },
              ],
            },
          });
        } else if (mode === "hang") {
          // leave the turn open — the keepalive interval below holds the
          // process while a test interrupts or kills the fleet
        } else if (mode === "malformed") {
          process.stdout.write("this is not json\n{broken\n");
          finishTurn();
        } else if (mode === "unknown-event") {
          // notifications a future app-server might add — fire-and-forget,
          // no reply expected; the driver must skip them, not crash
          notify("turn/sparkline/updated", { spark: [1, 2, 3] });
          notify("item/confetti", { itemId: "i1" });
          finishTurn();
        } else if (mode === "crash-mid-turn") {
          process.stderr.write("fake-codex: crashing mid-turn\n");
          process.exit(9);
        } else if (mode === "exit-zero") {
          notify("item/completed", { item: { id: "i1", type: "commandExecution", status: "completed" } });
          notify("item/completed", { item: { id: "m1", type: "agentMessage", text: "done from fake codex" } });
          dump();
          process.exit(0);
        } else {
          finishTurn();
        }
        break;
      default:
        if (msg.id !== undefined) out({ jsonrpc: "2.0", id: msg.id, result: {} });
    }
  }
});

// match the real app-server: stay alive until killed (exit-zero / exit-early
// end the process themselves)
if (mode !== "exit-zero" && mode !== "exit-early") setInterval(() => {}, 1_000);
