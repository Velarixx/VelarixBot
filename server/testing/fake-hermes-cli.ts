#!/usr/bin/env node
// Strict-grammar fake of the `hermes` CLI, for validating the EXACT argv
// hermes.ts spawns. The accept-anything fake-acp-cli.ts cannot falsify a
// spawn grammar — which is how the rc.12/rc.14 field failures shipped: the
// installed hermes rejected our argv, printed its usage, and exited 2,
// while `--version` kept the picker green. This fake is shaped like the
// FIELD binary (Hermes Agent v0.20.1): a clap-style argv gate in front of
// the shared ACP protocol fake:
//
//   default             accepts EXACTLY the v0.20.1 grammar hermes.ts emits —
//                       `[-m <model>] acp` (and `exec -p <prompt>` for
//                       one-shot generateText) — then delegates to
//                       fake-acp-cli.ts for the protocol. ANY other argv →
//                       usage on stderr, exit 2. In particular the OLD
//                       grammar (`--approval-policy … acp stdio`) and the
//                       global `--yolo` bypass are rejected, exactly like
//                       the field binary rejected the old spawn.
//   FAKE_HERMES_GRAMMAR=reject
//                       models a wrong/outdated binary: answers `--version`,
//                       rejects everything else with usage and exit 2 —
//                       never speaks ACP. Turns must fail loudly and
//                       snapshot must report unusable, not "available".
//   FAKE_HERMES_GRAMMAR=reject-signed-out
//                       models a credential-less binary that refuses ACP
//                       mode (usage + exit 2) until the pool store
//                       ~/.hermes/auth.json exists, then behaves like the
//                       default strict grammar. Pins the `hermes auth add`
//                       → identity-cache-recovers path.
//
// Keep this file dependency-free — it runs as a bare `node` subprocess.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);

// The field binary prints its secret-manager status on stderr on EVERY
// command (--version, exec, acp, rejected argv alike) when Bitwarden
// Secrets Manager is enabled. Version parsing, the identity probe, turns,
// and one-shot exec must all tolerate this stderr banner.
process.stderr.write("Bitwarden Secrets Manager: applied 1 secret\n");

if (argv.includes("--version")) {
  console.log("fake-hermes 0.20.1");
  process.exit(0);
}

// Mirrors the field CLI's rejection: unexpected argument → usage catalog on
// stderr, exit 2. `hermes acp --help` (v0.20.1) only knows --accept-hooks,
// --version, --check, --setup, --setup-browser, --yes — no --approval-policy,
// no trailing stdio. The command catalog matches v0.20.1: `login`/`logout`
// are REMOVED (the field binary answers `hermes login` with "The 'hermes
// login' command has been removed. Use 'hermes auth' …"); credentials are
// managed by `hermes auth` / `hermes model` / `hermes setup`.
const USAGE = [
  "error: unexpected argument found",
  "usage: hermes [-m MODEL] [--yolo] <command> [options]",
  "commands: acp, auth, exec, model, setup, orchestrator, pets, journey, plugins, skills",
].join("\n");

function rejectArgv(): never {
  process.stderr.write(USAGE + "\n");
  process.exit(2);
}

if (process.env.FAKE_HERMES_GRAMMAR === "reject") rejectArgv();
if (process.env.FAKE_HERMES_GRAMMAR === "reject-signed-out" && !existsSync(join(homedir(), ".hermes", "auth.json"))) {
  rejectArgv();
}

// one-shot generateText surface (`hermes exec -p <prompt>`), strict
if (argv[0] === "exec") {
  if (argv[1] !== "-p" || argv.length !== 3) rejectArgv();
  console.log("fake hermes one-shot");
  process.exit(0);
}

// turn/probe spawn: `[-m <model>] acp`, exactly and in order — anything else
// (the old `--approval-policy … acp stdio` grammar, a `--yolo` bypass, a
// trailing `stdio`) is the wrong grammar and gets the field binary's exit 2
const rest = [...argv];
if (rest[0] === "-m") {
  rest.shift();
  const model = rest.shift();
  if (!model || model.startsWith("-")) rejectArgv();
}
if (rest.length !== 1 || rest[0] !== "acp") rejectArgv();

// grammar accepted — speak ACP via the shared protocol fake
await import("./fake-acp-cli.ts");
