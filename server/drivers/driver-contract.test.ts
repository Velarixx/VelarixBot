// P1.4 — one conformance suite over every CLI-backed provider driver, run
// against the scripted fakes in server/testing/ (extend those fakes rather
// than mocking child_process — CONTRIBUTING.md). Each driver gets the same
// thirteen scenarios (start / resume / cancel / kill / permission / question
// / tool-order / partial-output / unknown-event / usage / malformed / drift
// / restart-mid-turn); the per-driver fixtures below say how to arrange each
// one, and the recorded transcripts live in
// server/testing/fixtures/driver-contract/<driverKind>.json.
//
// The API-backed drivers (grok/openrouter/omnirouter/boxAgent) speak HTTP,
// not a CLI protocol — they keep their own contract tests
// (openai-compat.test.ts, boxagent.test.ts) and are out of this suite.
//
// Runs on Windows too: the fakes are .ts paths, which resolveCliCommand
// executes via process.execPath on every platform — no shebang, no chmod.
import { readFileSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";

import { DATA_DIR } from "../config.ts";
import { runProviderDriverContract, type ScenarioContext } from "../testing/driver-contract.ts";
import { ClaudeDriver } from "./claude.ts";
import { CodexDriver } from "./codex.ts";
import { GeminiAgentDriver } from "./acp/gemini.ts";
import { GrokAgentDriver } from "./acp/grok.ts";
import { HermesAgentDriver } from "./acp/hermes.ts";

const TESTING_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "testing");
const FAKE_CLAUDE_CLI = join(TESTING_DIR, "fake-claude-cli.ts");
const FAKE_CODEX_CLI = join(TESTING_DIR, "fake-codex-app-server.ts");
const FAKE_ACP_CLI = join(TESTING_DIR, "fake-acp-cli.ts");

const readDump = (ctx: ScenarioContext) => JSON.parse(readFileSync(join(ctx.scratch, "dump.json"), "utf8"));

// ── codex ───────────────────────────────────────────────────────────────

runProviderDriverContract({
  createDriver: () =>
    CodexDriver.create({
      instanceId: "contract-codex",
      displayName: "Codex Contract",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CODEX_CLI, fullAuto: false },
    }),
  fixtures: {
    driverKind: "codex",
    finalText: "done from fake codex",
    scenarios: {
      start: {},
      resume: { env: { FAKE_CODEX_MODE: "resume" }, cursor: "codex-thread-9" },
      cancel: { env: { FAKE_CODEX_MODE: "hang" }, after: "item.started" },
      kill: { env: { FAKE_CODEX_MODE: "hang" }, after: "item.started" },
      permission: { env: { FAKE_CODEX_MODE: "approval" }, expectTool: "shell" },
      question: {
        // conversational requestUserInput is auto-answered in-band — a card
        // here would wedge headless runs on an A/B/C nobody will click
        style: "auto-answered",
        env: ({ scratch }) => ({ FAKE_CODEX_MODE: "user-input", FAKE_CODEX_DUMP: join(scratch, "dump.json") }),
        verify: (ctx) => {
          const answer = readDump(ctx).decision.answers.next.answers[0];
          expect(answer).toMatch(/create_bot|chat/i);
          expect(answer).not.toMatch(/Create a Chief of Staff/);
        },
      },
      "tool-order": {},
      "partial-output": { env: { FAKE_CODEX_MODE: "stream" }, deltas: ["done from ", "fake codex"] },
      "unknown-event": { env: { FAKE_CODEX_MODE: "unknown-event" } },
      usage: { expect: { input: 7, output: 3 } },
      malformed: { env: { FAKE_CODEX_MODE: "malformed" } },
      drift: {
        env: ({ scratch }) => ({ FAKE_CODEX_MODE: "unknown-method", FAKE_CODEX_DUMP: join(scratch, "dump.json") }),
        // codex surfaces the refusal as runtime.error alongside the -32601
        expectRuntimeError: true,
        verify: (ctx) => {
          const { decision } = readDump(ctx);
          expect(decision).toEqual({ error: { code: -32601, message: "Method not found: item/tool/call" } });
        },
      },
      "restart-mid-turn": { crash: { env: { FAKE_CODEX_MODE: "crash-mid-turn" } } },
    },
  },
});

// ── claude ──────────────────────────────────────────────────────────────

// Claude asks arrive over the per-turn permission-broker socket (the MCP
// proxy's path), not the CLI's stdout — raise them the way the proxy would.
// Same tag rule as permissionSocketPath in claude.ts.
function claudeAsk(ask: { id: string; kind?: string; tool: string; input: Record<string, unknown> }) {
  return async ({ threadId }: ScenarioContext): Promise<() => Promise<void>> => {
    const tag = threadId.replace(/[^\w-]/g, "").slice(0, 8);
    const socketPath =
      process.platform === "win32" ? `\\\\.\\pipe\\velarix-perm-${tag}` : join(DATA_DIR, `perm-${tag}.sock`);
    const conn = connect(socketPath);
    conn.on("error", () => {});
    await new Promise<void>((resolve, reject) => {
      conn.on("connect", resolve);
      conn.on("error", reject);
    });
    await new Promise<void>((resolve, reject) => {
      conn.write(JSON.stringify({ t: "ask", ...ask }) + "\n", (error) => (error ? reject(error) : resolve()));
    });
    return () =>
      new Promise<void>((resolve) => {
        if (conn.destroyed) {
          resolve();
          return;
        }
        conn.once("close", resolve);
        conn.destroy();
      });
  };
}

runProviderDriverContract({
  createDriver: () =>
    ClaudeDriver.create({
      instanceId: "contract-claude",
      displayName: "Claude Contract",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLAUDE_CLI, permissionMode: "acceptEdits" },
    }),
  fixtures: {
    driverKind: "claudeAgent",
    finalText: "hello from fake claude",
    scenarios: {
      start: {},
      resume: { cursor: "sess-contract-1" },
      cancel: { env: { FAKE_CLAUDE_MODE: "hang" }, after: "session.started" },
      kill: { env: { FAKE_CLAUDE_MODE: "hang" }, after: "session.started" },
      permission: {
        env: { FAKE_CLAUDE_MODE: "hang" },
        raise: claudeAsk({ id: "ask-perm", tool: "Bash", input: { command: "rm -rf scratch" } }),
        expectTool: "Bash",
        interruptToEnd: true,
      },
      question: {
        style: "carded",
        env: { FAKE_CLAUDE_MODE: "hang" },
        raise: claudeAsk({
          id: "ask-q",
          kind: "question",
          tool: "ask_user",
          input: { question: "Which niche should the newsletter cover first?" },
        }),
        expectTool: "ask_user",
        answer: "Start with indie game developers.",
        interruptToEnd: true,
      },
      "tool-order": {},
      "partial-output": { env: { FAKE_CLAUDE_MODE: "stream" }, deltas: ["hello from ", "fake claude"] },
      "unknown-event": { env: { FAKE_CLAUDE_MODE: "unknown-event" } },
      usage: { expect: { input: 12, output: 5 } }, // input + cache_read
      malformed: { env: { FAKE_CLAUDE_MODE: "malformed" } },
      drift: {
        unsupported:
          "stream-json is notification-only — no server→client request channel to drift on; unknown frames are covered by unknown-event",
      },
      "restart-mid-turn": { crash: { env: { FAKE_CLAUDE_MODE: "crash-mid-turn" } } },
    },
  },
});

// ── the ACP trio (grok / gemini / hermes) ───────────────────────────────
// One shared runtime (acp/core.ts), one shared fake, three harness shims —
// the contract runs over each registered driver, not just the core, so a
// shim regression (argv, auth, env hygiene breaking the turn) still fails.

function acpFixtures(driverKind: string) {
  return {
    driverKind,
    finalText: "hello from fake acp",
    scenarios: {
      start: {},
      resume: { cursor: "fake-acp-session" },
      cancel: { env: { FAKE_ACP_MODE: "hang" }, after: "session.started" as const },
      kill: { env: { FAKE_ACP_MODE: "hang" }, after: "session.started" as const },
      permission: { env: { FAKE_ACP_MODE: "permission" }, expectTool: "shell" },
      question: {
        unsupported: "ACP surfaces agent asks only as session/request_permission — there is no question-style ask",
      },
      "tool-order": {},
      "partial-output": { deltas: ["hello from fake acp"] },
      "unknown-event": { env: { FAKE_ACP_MODE: "unknown-event" } },
      usage: { expect: { input: 10, output: 5 } },
      malformed: { env: { FAKE_ACP_MODE: "malformed" } },
      drift: {
        env: ({ scratch }: { scratch: string }) => ({
          FAKE_ACP_MODE: "unknown-request",
          FAKE_ACP_DUMP: join(scratch, "dump.json"),
        }),
        verify: (ctx: ScenarioContext) => {
          const { unknownRequestReply } = readDump(ctx);
          expect(unknownRequestReply.result).toBeNull();
          expect(unknownRequestReply.error).toMatchObject({ code: -32601 });
        },
      },
      "restart-mid-turn": { crash: { env: { FAKE_ACP_MODE: "crash-mid-turn" } } },
    },
  } satisfies Parameters<typeof runProviderDriverContract>[0]["fixtures"];
}

runProviderDriverContract({
  createDriver: () =>
    GrokAgentDriver.create({
      instanceId: "contract-grok",
      displayName: "Grok Contract",
      environment: {},
      enabled: true,
      config: { cli: FAKE_ACP_CLI, fullAuto: false },
    }),
  fixtures: acpFixtures("grokAgent"),
});

runProviderDriverContract({
  createDriver: () =>
    GeminiAgentDriver.create({
      instanceId: "contract-gemini",
      displayName: "Gemini Contract",
      environment: {},
      enabled: true,
      config: { cli: FAKE_ACP_CLI, fullAuto: false },
    }),
  fixtures: acpFixtures("geminiAgent"),
});

runProviderDriverContract({
  createDriver: () =>
    HermesAgentDriver.create({
      instanceId: "contract-hermes",
      displayName: "Hermes Contract",
      // hermes fails closed unless the fake advertises an agent-managed
      // pool provider (v0.20.1 shape: provider + terminal setup method)
      environment: { FAKE_ACP_AUTH_IDS: "openai-codex,hermes-setup:terminal" },
      enabled: true,
      config: { cli: FAKE_ACP_CLI, fullAuto: false },
    }),
  fixtures: acpFixtures("hermesAgent"),
});
