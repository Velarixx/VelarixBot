#!/usr/bin/env node
// Strict-grammar fake of the `gemini` CLI, for validating the EXACT argv
// gemini.ts spawns. The accept-anything fake-acp-cli.ts cannot falsify a
// spawn grammar — the rc.12/rc.14 Hermes field failures shipped because
// only accept-anything fakes ever saw the argv. This fake is shaped like a
// live gemini-cli 0.55.1 (probed 2026-08-16): a yargs-style argv gate in
// front of the shared ACP protocol fake:
//
//   default             accepts EXACTLY the grammar gemini.ts emits —
//                       `--acp --approval-mode default [-m <model>]` (plus
//                       `-p <prompt>` for one-shot generateText) — then
//                       delegates to fake-acp-cli.ts for the protocol,
//                       advertising the REAL 0.55.1 auth method ids
//                       (oauth-personal, gemini-api-key, vertex-ai,
//                       gateway — advertised unconditionally, signed in or
//                       not) and the REAL 0.55.1 session/new model catalog.
//                       ANY other argv → "Unknown argument" + usage on
//                       stderr, exit 1, like the real yargs CLI.
//   FAKE_GEMINI_GRAMMAR=reject
//                       models a wrong/outdated binary: answers `--version`,
//                       rejects everything else with usage and exit 1 —
//                       never speaks ACP. Turns must fail loudly and
//                       snapshot must report unusable, not "available".
//   FAKE_GEMINI_AUTH=signed-out
//                       models the real signed-out machine: initialize
//                       still advertises every auth method, authenticate
//                       would still "succeed" (it only selects a method) —
//                       session/new is the gate, failing with -32000
//                       "Gemini API key is missing or not configured."
//
// Keep this file dependency-free — it runs as a bare `node` subprocess.
const argv = process.argv.slice(2);

// The real CLI is chatty on stderr even when healthy (untrusted-folder and
// ripgrep notices on every --acp start). Version parsing, the identity
// probe, turns, and one-shot -p must all tolerate this banner.
process.stderr.write("Skipping project agents due to untrusted folder.\n");

if (argv.includes("--version")) {
  console.log("fake-gemini 0.55.1");
  process.exit(0);
}

// Mirrors the real CLI's rejection: yargs prints the unknown argument and
// its usage on stderr and exits 1.
const USAGE = [
  "Unknown argument",
  "Usage: gemini [options] [command]",
  "Commands: gemini mcp, gemini extensions <command>, gemini skills <command>, gemini hooks <command>, gemini gemma",
].join("\n");

function rejectArgv(): never {
  process.stderr.write(USAGE + "\n");
  process.exit(1);
}

if (process.env.FAKE_GEMINI_GRAMMAR === "reject") rejectArgv();

// one-shot generateText surface (`gemini -p <prompt>`), strict
if (argv[0] === "-p") {
  if (argv.length !== 2) rejectArgv();
  console.log("fake gemini one-shot");
  process.exit(0);
}

// turn/probe spawn: `--acp --approval-mode default [-m <model>]`, exactly
// and in order — the deprecated `--experimental-acp`, the `--yolo` bypass,
// and any non-default approval mode are the wrong grammar
const rest = [...argv];
if (rest.shift() !== "--acp") rejectArgv();
if (rest.shift() !== "--approval-mode") rejectArgv();
if (rest.shift() !== "default") rejectArgv();
if (rest.length > 0) {
  if (rest.shift() !== "-m") rejectArgv();
  const model = rest.shift();
  if (!model || model.startsWith("-")) rejectArgv();
}
if (rest.length > 0) rejectArgv();

// grammar accepted — speak ACP via the shared protocol fake, shaped like
// the live 0.55.1: methods advertised unconditionally, model catalog on the
// session result (no _meta.modelState in initialize)
process.env.FAKE_ACP_AUTH_IDS ??= "oauth-personal,gemini-api-key,vertex-ai,gateway";
process.env.FAKE_ACP_SESSION_MODELS ??=
  "auto,gemini-3.1-pro-preview-customtools,gemini-3-flash-preview,gemini-2.5-pro,gemini-3.5-flash,gemini-3.1-flash-lite";
if (process.env.FAKE_GEMINI_AUTH === "signed-out") {
  process.env.FAKE_ACP_MODE = "session-auth-error";
  process.env.FAKE_ACP_SESSION_AUTH_MESSAGE = "Gemini API key is missing or not configured.";
}
await import("./fake-acp-cli.ts");
