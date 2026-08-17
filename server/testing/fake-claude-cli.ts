#!/usr/bin/env node
// Fake of the claude CLI's stream-json surface, for driver tests.
// Reads the prompt from stdin (one stream-json line), then plays a
// scripted session. Failure modes are toggled by env var, mirroring how
// the real thing misbehaves:
//
//   FAKE_CLAUDE_MODE   happy (default) | exit-early | hang | malformed
//                      | stream (partial-message text deltas before the
//                        whole-message frame, plus subagent noise to drop)
//                      | unknown-event (frames a future CLI might add — the
//                        driver must skip them, then complete normally)
//                      | crash-mid-turn (init + a partial delta, then exit 9
//                        without a result — the restart-mid-turn shape)
//   FAKE_CLAUDE_DUMP   path to write {argv, env, prompt, mcpConfig, mcpConfigMode}
//                      as JSON, so the test can assert on argv shape and env
//                      hygiene. mcpConfig is read back from the --mcp-config
//                      file the way the real CLI reads it — the driver writes
//                      it to a private temp file and deletes it when the turn
//                      settles, so a test cannot open it after the fact.
//   FAKE_CLAUDE_AUTH   in (default) | out | unsupported | malformed |
//                      inherited-api-key — what `auth status --json` reports.
//                      Anything other than exactly `auth status --json` is
//                      rejected (strict fake — an accept-anything probe would
//                      hide a driver that dropped --json).
//
// Keep this file dependency-free — it runs as a bare `node` subprocess.
import { readFileSync, statSync, writeFileSync } from "node:fs";

const mode = process.env.FAKE_CLAUDE_MODE ?? "happy";

const argv = process.argv.slice(2);
const argAfter = (flag: string): string | null => {
  const i = argv.indexOf(flag);
  return i === -1 ? null : (argv[i + 1] ?? null);
};

if (argv.includes("--version")) {
  process.stdout.write("fake-claude 1.0.0\n");
  process.exit(0);
}

// Snapshot probes: answer on argv alone and exit without reading stdin.
// Strict: only `auth status --json`. Missing --json or a different subcommand
// is a hard fail so a driver that probes credentials.json / bare `auth status`
// cannot hide behind an accept-anything fake.
if (argv[0] === "auth") {
  if (argv[1] !== "status" || !argv.includes("--json")) {
    process.stderr.write("error: expected `auth status --json`\n");
    process.exit(1);
  }
  const auth = process.env.FAKE_CLAUDE_AUTH ?? "in";
  if (auth === "unsupported") {
    process.stderr.write("error: unknown command 'auth'\n");
    process.exit(1);
  }
  if (auth === "malformed") {
    process.stdout.write("not json\n");
    process.exit(0);
  }
  const loggedIn = auth === "in" || (auth === "inherited-api-key" && Boolean(process.env.ANTHROPIC_API_KEY));
  process.stdout.write(
    JSON.stringify({ loggedIn, authMethod: loggedIn ? "claude.ai" : "none", apiProvider: "firstParty" }) + "\n",
  );
  process.exit(auth === "out" ? 1 : 0);
}

// generateText one-shot (`-p … --output-format text`). Regular turns use
// `--output-format stream-json` and fall through to the stdin script.
if (argAfter("--output-format") === "text") {
  process.stdout.write("User prefers concise replies. Last turn noted.\n");
  process.exit(0);
}

const out = (obj: unknown) => process.stdout.write(JSON.stringify(obj) + "\n");

let stdin = "";
process.stdin.on("data", (c) => (stdin += c));
process.stdin.on("end", () => {
  let prompt: unknown = null;
  try {
    prompt = JSON.parse(stdin.split("\n").find((l) => l.trim()) ?? "null");
  } catch {
    /* leave null — the test will see it */
  }

  if (process.env.FAKE_CLAUDE_DUMP) {
    const configPath = argAfter("--mcp-config");
    let mcpConfig: unknown = null;
    let mcpConfigMode: number | null = null;
    if (configPath) {
      try {
        mcpConfig = JSON.parse(readFileSync(configPath, "utf8"));
        mcpConfigMode = statSync(configPath).mode & 0o777;
      } catch {
        /* leave null — the test will see it */
      }
    }
    writeFileSync(
      process.env.FAKE_CLAUDE_DUMP,
      JSON.stringify({ argv, env: process.env, prompt, mcpConfig, mcpConfigMode }, null, 2),
    );
  }

  const sessionId = argAfter("--resume") ?? argAfter("--session-id") ?? "fake-session";
  const model = argAfter("--model") ?? "claude-fake";

  if (mode === "exit-early") {
    process.stderr.write("fake-claude: simulated crash before result\n");
    process.exit(3);
  }

  out({ type: "system", subtype: "init", session_id: sessionId, model });

  if (mode === "hang") {
    // stay alive until killed — lets tests exercise interrupt + the
    // permission broker while a turn is officially in flight
    setInterval(() => {}, 1_000);
    return;
  }

  if (mode === "crash-mid-turn") {
    out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "partial " } } });
    process.stderr.write("fake-claude: crashing mid-turn\n");
    process.exit(9);
  }

  if (mode === "malformed") {
    process.stdout.write("this is not json\n{broken\n");
  }

  if (mode === "unknown-event") {
    // frames a future CLI might add — the driver must skip them, not crash
    out({ type: "sparkline", data: [1, 2, 3] });
    out({ type: "system", subtype: "future_subtype", detail: "ignore me" });
  }

  if (mode === "stream") {
    const delta = (d: unknown) => out({ type: "stream_event", event: { type: "content_block_delta", delta: d } });
    delta({ type: "thinking_delta", thinking: "hmm" });
    delta({ type: "text_delta", text: "hello from " });
    delta({ type: "text_delta", text: "fake claude" });
    // subagent narration — the driver must drop this, not render it
    out({
      type: "stream_event",
      parent_tool_use_id: "task-1",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "SUBAGENT NOISE" } },
    });
  }

  out({
    type: "assistant",
    message: {
      content: [
        { type: "text", text: "hello from fake claude" },
        { type: "tool_use", id: "tu-1", name: "Bash" },
      ],
      usage: { input_tokens: 10, cache_read_input_tokens: 2, output_tokens: 5 },
    },
  });
  out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu-1", is_error: false }] } });
  out({ type: "result", is_error: false, stop_reason: "end_turn", total_cost_usd: 0.01 });
  process.exit(0);
});
