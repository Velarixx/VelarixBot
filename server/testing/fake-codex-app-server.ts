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
//                     | exit-zero (assistant text, then process.exit(0)
//                       without turn/completed)
//                     | exit-early (crash with code 3 before a turn)
//   FAKE_CODEX_DUMP   path to write {argv, env, calls, decision,
//                     threadStartConfig, threadResumeConfig} as JSON
//
// Keep this file dependency-free — it runs as a bare `node` subprocess.
import { writeFileSync } from "node:fs";

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
