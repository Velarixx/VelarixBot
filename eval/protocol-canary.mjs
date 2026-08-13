// Cheap Codex app-server protocol-drift canary.
//   node eval/protocol-canary.mjs         — skip (exit 0) without Codex secret; else run
//   node eval/protocol-canary.mjs --gate  — presence check only (writes GITHUB_OUTPUT ran=)
// The workflow installs the real Codex CLI. This script lists advertised
// app-server methods/features (including mcpServer/elicitation/request and
// tool_call_mcp_elicitation) and hard-fails if handleServerRequest does not
// implement them. Unknown methods must not be answered with a fake success.
// Never logs or writes secret values. Temp CODEX_HOME only.

import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { SECRET_NAMES, secretValues } from "./secrets.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const REPO = join(ROOT, "..");
const DRIVER = join(REPO, "server", "drivers", "codex.ts");

export const REQUIRED_METHOD = "mcpServer/elicitation/request";
export const REQUIRED_FEATURE = "tool_call_mcp_elicitation";

const SERVER_REQUEST_NEEDLES = [
  REQUIRED_METHOD,
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "item/tool/requestUserInput",
  "tool/requestUserInput",
  "execCommandApproval",
  "applyPatchApproval",
];

function present(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export function skipMessage() {
  return [
    "Skipping Codex protocol canary: no Codex secret configured.",
    `Expected secret name (value is human-owned; never commit it): ${SECRET_NAMES.codex}`,
    "Exit 0 so forks stay green without secrets.",
  ].join("\n");
}

function writeGate(ran) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `ran=${ran}\n`);
}

function redact(text, values) {
  let out = String(text ?? "");
  for (const value of values) {
    if (value && value.length > 4) out = out.split(value).join("[redacted]");
  }
  return out;
}

/** What handleServerRequest must cover. Pure string check so unit tests run
 * without a Codex CLI. The live job still lists advertised names from the CLI. */
export function driverGaps(source) {
  const missing = [];
  if (!/handleServerRequest\s*=/.test(source)) missing.push("handleServerRequest is missing");
  if (!source.includes(REQUIRED_METHOD)) missing.push(`${REQUIRED_METHOD} is not implemented`);
  if (!source.includes(REQUIRED_FEATURE)) {
    missing.push(`${REQUIRED_FEATURE} is not acknowledged (MCP approvals go through elicitation)`);
  }
  if (!source.includes("-32601")) {
    missing.push("unknown methods are not rejected with JSON-RPC -32601 (do not fake-success them)");
  }
  return missing;
}

function whichCodex() {
  const fromEnv = process.env.CODEX_CLI?.trim();
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const path = process.env.PATH ?? "";
  for (const dir of path.split(":")) {
    const candidate = join(dir, "codex");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function needlesIn(buf) {
  return SERVER_REQUEST_NEEDLES.filter((name) => buf.includes(Buffer.from(name)));
}

function walkFiles(dir, acc, depth = 0) {
  if (depth > 4 || acc.length > 40) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" && depth > 0) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(path, acc, depth + 1);
    else if (entry.isFile() || entry.isSymbolicLink()) acc.push(path);
  }
}

export function advertisedMethodsFromInstall(cli) {
  const files = [cli];
  const dir = dirname(cli);
  if (/node_modules|@openai|\bcodex\b/i.test(dir)) walkFiles(dir, files);
  const npmRoot = spawnSync("npm", ["root", "-g"], { encoding: "utf8" });
  if (npmRoot.status === 0) {
    const pkg = join(npmRoot.stdout.trim(), "@openai", "codex");
    if (existsSync(pkg)) walkFiles(pkg, files);
  }
  const found = new Set();
  for (const file of files) {
    try {
      const st = statSync(file);
      if (!st.isFile() || st.size > 80 * 1024 * 1024) continue;
      for (const name of needlesIn(readFileSync(file))) found.add(name);
    } catch {
      /* unreadable */
    }
    if (found.has(REQUIRED_METHOD) && found.size >= 3) break;
  }
  return [...found];
}

function featureName(row) {
  if (!row || typeof row !== "object") return "";
  return String(row.name ?? row.flagName ?? row.key ?? "").trim();
}

function featuresFromCliText(text) {
  const names = [];
  for (const line of String(text).split(/\r?\n/)) {
    const hit = line.match(/\b([a-z][a-z0-9_]{2,})\b/g);
    if (!hit) continue;
    for (const name of hit) {
      if (name.includes("_") || name.startsWith("tool")) names.push(name);
    }
  }
  return [...new Set(names)];
}

async function listFeaturesFromAppServer(cli, home) {
  const env = {
    ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
    HOME: home,
    USERPROFILE: home,
    CODEX_HOME: join(home, ".codex"),
  };
  const child = spawn(cli, ["app-server"], { cwd: home, env, stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map();
  let nextId = 1;
  const send = (obj) => child.stdin.write(`${JSON.stringify(obj)}\n`);
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, 15_000);
      timer.unref?.();
      pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      send({ jsonrpc: "2.0", id, method, params });
    });

  let buf = "";
  child.stdout.on("data", (chunk) => {
    buf += String(chunk);
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const wait = pending.get(msg.id);
      if (!wait) continue;
      pending.delete(msg.id);
      if (msg.error) wait.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
      else wait.resolve(msg.result);
    }
  });

  try {
    await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("spawn", resolve);
    });
    await request("initialize", {
      clientInfo: { name: "velarixbot-canary", version: "1" },
      capabilities: { experimentalApi: true },
    });
    send({ jsonrpc: "2.0", method: "initialized", params: {} });

    const features = [];
    let cursor;
    for (let i = 0; i < 20; i++) {
      const result = await request("experimentalFeature/list", cursor ? { cursor } : {});
      for (const row of Array.isArray(result?.data) ? result.data : []) {
        const name = featureName(row);
        if (name) features.push(name);
      }
      cursor = result?.nextCursor;
      if (!cursor) break;
    }
    return features;
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.on("close", () => resolve());
      setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 3_000).unref?.();
    });
  }
}

function listFeaturesFromCli(cli, home, values) {
  const result = spawnSync(cli, ["features", "list"], {
    cwd: home,
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      HOME: home,
      USERPROFILE: home,
      CODEX_HOME: join(home, ".codex"),
    },
    encoding: "utf8",
    timeout: 20_000,
  });
  return featuresFromCliText(redact(`${result.stdout ?? ""}\n${result.stderr ?? ""}`, values));
}

async function main() {
  const found = present(process.env[SECRET_NAMES.codex]);
  const gate = process.argv.includes("--gate");

  if (gate) {
    writeGate(found ? "true" : "false");
    console.log(found ? "Protocol canary will run." : skipMessage());
    process.exit(0);
  }

  if (!found) {
    writeGate("false");
    console.log(skipMessage());
    process.exit(0);
  }

  writeGate("true");
  const values = secretValues(process.env);
  const source = readFileSync(DRIVER, "utf8");
  const gaps = driverGaps(source);

  const cli = whichCodex();
  if (!cli) {
    console.error("codex CLI not on PATH. The workflow must install @openai/codex before this step.");
    process.exit(1);
  }

  const home = process.env.EVAL_HOME || join(tmpdir(), `velarixbot-canary-${process.pid}`);
  mkdirSync(join(home, ".codex"), { recursive: true, mode: 0o700 });
  writeFileSync(join(home, ".codex", "auth.json"), process.env[SECRET_NAMES.codex], { mode: 0o600 });

  let methods = [];
  let features = [];
  try {
    methods = advertisedMethodsFromInstall(cli);
    try {
      features = await listFeaturesFromAppServer(cli, home);
    } catch (err) {
      console.log(redact(`experimentalFeature/list failed, falling back to codex features list: ${err instanceof Error ? err.message : err}`, values));
      features = listFeaturesFromCli(cli, home, values);
    }
    if (!features.includes(REQUIRED_FEATURE)) {
      const extra = listFeaturesFromCli(cli, home, values);
      features = [...new Set([...features, ...extra])];
    }
  } catch (err) {
    console.error(redact(err instanceof Error ? err.stack || err.message : String(err), values));
    if (!process.env.EVAL_KEEP_HOME) rmSync(home, { recursive: true, force: true });
    process.exit(1);
  }
  if (!process.env.EVAL_KEEP_HOME) rmSync(home, { recursive: true, force: true });

  const missingAdvertised = [];
  if (!methods.includes(REQUIRED_METHOD)) missingAdvertised.push(`CLI does not advertise ${REQUIRED_METHOD}`);
  if (!features.includes(REQUIRED_FEATURE)) missingAdvertised.push(`CLI does not advertise feature ${REQUIRED_FEATURE}`);

  const md = [
    "## Codex protocol canary",
    "",
    "Presence only — secret values are never logged.",
    `\`${SECRET_NAMES.codex}\`: configured`,
    "",
    "### Advertised methods (from the installed CLI)",
    methods.length ? methods.map((m) => `- \`${m}\``).join("\n") : "_none found_",
    "",
    "### Advertised features",
    features.length ? features.map((f) => `- \`${f}\``).join("\n") : "_none found_",
    "",
    "### Driver (`server/drivers/codex.ts` handleServerRequest)",
    gaps.length ? gaps.map((g) => `- FAIL: ${g}`).join("\n") : "- implements elicitation + unknown-method -32601",
    "",
  ].join("\n");
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
  console.log(md);

  const fail = [...missingAdvertised, ...gaps];
  if (fail.length) {
    console.error(`Protocol canary failed:\n${fail.map((f) => `- ${f}`).join("\n")}`);
    process.exit(1);
  }
}

const entry = process.argv[1] ?? "";
if (entry.endsWith("protocol-canary.mjs") && !process.env.VITEST) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
