// Release gate: boot the file electron/main.mjs forks
// (`resources/server/index.js`) far enough to answer /api/health, and prove
// it is current code. Hash-check is necessary but not sufficient — rc.6–rc.8
// shipped a stale rc.3 server that would still listen.
//
// Headless `node` boot of the packaged entry; no Electron GUI. Does not
// spread process.env (no Actions secrets). Markers are the cheap check that
// would have failed rc.3-in-rc.8; health.stamp is the same proof from the
// running process.
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CURRENT_CODE_MARKERS = ["ensureBotWorkspace", "mcpOverlay"];
export const SERVER_SMOKE_STAMP = CURRENT_CODE_MARKERS.join("+");

const IS_WIN = process.platform === "win32";

export function readPackagedJsTree(entryPath) {
  const root = dirname(resolve(entryPath));
  const chunks = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name === "node_modules") continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile() && e.name.endsWith(".js")) chunks.push(readFileSync(p, "utf8"));
    }
  }
  return chunks.join("\n");
}

export function assertCurrentPackagedCode(entryPath) {
  const entry = resolve(entryPath);
  if (!existsSync(entry)) {
    throw new Error(`packaged server missing at ${entry} (the path main.mjs forks)`);
  }
  const tree = readPackagedJsTree(entry);
  const missing = CURRENT_CODE_MARKERS.filter((m) => !tree.includes(m));
  if (missing.length) {
    throw new Error(
      `packaged server is stale (missing ${missing.join(", ")} under ${dirname(entry)}). ` +
        `This is the rc.3-in-rc.8 class: bytes listen but are not current code.`,
    );
  }
  if (!tree.includes(SERVER_SMOKE_STAMP)) {
    throw new Error(`packaged server is stale: missing smoke stamp ${SERVER_SMOKE_STAMP} under ${dirname(entry)}`);
  }
}

export function smokeEnv(home, port) {
  return {
    ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    HOME: home,
    USERPROFILE: home,
    OMB_PORT: String(port),
  };
}

export function freePort() {
  return new Promise((resolvePort, reject) => {
    const s = createServer();
    s.unref();
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      s.close((err) => (err ? reject(err) : resolvePort(port)));
    });
    s.on("error", reject);
  });
}

export function killSmokeChild(child) {
  const pid = child?.pid;
  if (!pid) return;
  if (IS_WIN) {
    try {
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    } catch {
      /* already gone */
    }
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

/**
 * @param {string} base
 * @param {import("node:child_process").ChildProcess} child
 * @param {() => string} stderr
 * @param {number} [timeoutMs]
 * @returns {Promise<{ app: string, pid: number, stamp: string, static?: boolean }>}
 */
export async function waitForPackagedHealth(base, child, stderr, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = "";
  for (;;) {
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) {
        const body = await res.json();
        if (body?.app !== "velarixbot") {
          throw new Error(`health did not identify as velarixbot: ${JSON.stringify(body)}`);
        }
        if (body.pid !== child.pid) {
          throw new Error(`health pid ${body.pid} is not the child we forked (${child.pid})`);
        }
        if (body.stamp !== SERVER_SMOKE_STAMP) {
          throw new Error(
            `health stamp ${JSON.stringify(body.stamp)} is not current (${SERVER_SMOKE_STAMP}). ` +
              `Stale packaged server (rc.3-in-rc.8 class).`,
          );
        }
        return body;
      }
      lastErr = `HTTP ${res.status}`;
    } catch (e) {
      if (e instanceof Error && /did not identify|health pid|health stamp/.test(e.message)) throw e;
      lastErr = e instanceof Error ? e.message : String(e);
    }
    if (Date.now() > deadline) {
      throw new Error(`packaged server never answered current health at ${base}/api/health (${lastErr}). stderr:\n${stderr()}`);
    }
    if (child.exitCode !== null) {
      throw new Error(`packaged server exited ${child.exitCode} before health. stderr:\n${stderr()}`);
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}

/**
 * @param {string} entryPath
 * @param {{ port?: number, timeoutMs?: number }} [opts]
 * @returns {Promise<{ health: { app: string, pid: number, stamp: string, static?: boolean }, port: number, entry: string }>}
 */
export async function smokePackagedServer(entryPath, opts = {}) {
  const entry = resolve(entryPath);
  assertCurrentPackagedCode(entry);
  const port = opts.port ?? (await freePort());
  const home = mkdtempSync(join(tmpdir(), "omb-packaged-smoke-"));
  let stderr = "";
  const child = spawn(process.execPath, [entry], {
    cwd: dirname(entry),
    env: smokeEnv(home, port),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stderr?.on("data", (c) => {
    stderr += c;
  });
  child.stdout?.on("data", () => {
    /* discard — do not echo server logs (may mention paths) */
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    const health = await waitForPackagedHealth(base, child, () => stderr, opts.timeoutMs);
    return { health, port, entry };
  } finally {
    killSmokeChild(child);
    await new Promise((resolveClose) => {
      if (!child || child.exitCode !== null) return resolveClose();
      child.on("close", () => resolveClose());
      setTimeout(() => {
        killSmokeChild(child);
        resolveClose();
      }, 5_000).unref?.();
    });
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {
      /* Windows: a late child may still hold the temp home */
    }
  }
}

function print(msg) {
  process.stdout.write(`${msg}\n`);
}

function fail(err) {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}

async function cli(argv = process.argv.slice(2)) {
  const entry = argv[0];
  if (!entry || entry.startsWith("-")) fail("usage: node scripts/smoke-packaged-server.mjs <packaged-server/index.js>");
  const shown = relative(process.cwd(), resolve(entry)) || entry;
  print(`smoking packaged server ${shown}`);
  const { health, port } = await smokePackagedServer(entry);
  print(`packaged server health ok on :${port} stamp=${health.stamp} pid=${health.pid}`);
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  cli().catch(fail);
}
