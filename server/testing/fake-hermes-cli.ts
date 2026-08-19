#!/usr/bin/env node
// Strict-grammar fake of the `hermes` CLI, for validating the EXACT argv
// hermes.ts spawns. The accept-anything fake-acp-cli.ts cannot falsify a
// spawn grammar — which is how the rc.12/rc.14 field failures shipped: the
// installed hermes rejected our argv, printed its usage, and exited 2,
// while `--version` kept the picker green. This fake is shaped like the
// tagged binary (Hermes Agent v0.20.4 / v2026.8.18): an argv gate in front of
// the shared ACP protocol fake:
//
//   default             accepts EXACTLY the documented v0.20.4 surfaces this
//                       driver uses: `[-m <model>] acp`, `auth list` for the
//                       snapshot cache hint, and `--version`. It then delegates
//                       ACP to fake-acp-cli.ts in its v0.20.4 frame mode. ANY
//                       other argv → usage on stderr, exit 2. In particular
//                       `exec -p` is not a v0.20.4 command and the OLD
//                       grammar (`--approval-policy … acp stdio`) and the
//                       global `--yolo` bypass are rejected, exactly like
//                       the tagged parser rejects unsupported argv.
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
  console.log("Hermes Agent v0.20.4 (2026.8.18)");
  process.exit(0);
}

// Mirrors the tagged CLI's argparse rejection: usage on stderr, exit 2.
// `hermes acp --help` (v0.20.4) knows --accept-hooks,
// --version, --check, --setup, --setup-browser, --yes — no --approval-policy,
// no trailing stdio. Keep the error generic rather than fabricating argparse's
// enormous generated command catalog; the documented grammar is the contract.
const USAGE = [
  "usage: hermes [global-options] <command> [subcommand/options]",
  "hermes: error: unrecognized command or arguments",
].join("\n");

function rejectArgv(): never {
  process.stderr.write(USAGE + "\n");
  process.exit(2);
}

if (process.env.FAKE_HERMES_GRAMMAR === "reject") rejectArgv();
if (process.env.FAKE_HERMES_GRAMMAR === "reject-signed-out" && !existsSync(join(homedir(), ".hermes", "auth.json"))) {
  rejectArgv();
}

// pool-listing surface (`hermes auth list`) — the v0.20.4 credential
// manager the snapshot cache hint asks before any file. Strict: only the
// exact `auth list` argv; the listing mirrors FAKE_ACP_AUTH_IDS'
// agent-managed entries, like the real CLI mirrors its resolved pool.
if (argv[0] === "auth") {
  if (argv[1] !== "list" || argv.length !== 2) rejectArgv();
  const pool = (process.env.FAKE_ACP_AUTH_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((spec) => spec.split(":"))
    .filter(([id, type]) => id && id !== "hermes-setup" && type !== "terminal");
  if (pool.length === 0) console.log("No credentials configured.");
  for (const [id] of pool) console.log(`${id} (1 credential):\n  oauth device_code`);
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

// Grammar accepted — speak the tagged Hermes v0.20.4 ACP frame shape via the
// shared protocol fake. This is set only after argv validation, so an invalid
// command can never be made to look successful by the protocol fixture.
process.env.FAKE_ACP_FIXTURE = "hermes-v0.20.4";
await import("./fake-acp-cli.ts");
