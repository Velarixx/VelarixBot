// Local attach credential for the user-session harness.
//
// [VERIFY] 2026-08-18 HEAD (b0d1ec7) probed facts — do not guess:
//   - electron/main.mjs mints one VELARIX_API_TOKEN per GUI launch and
//     injects it only as env on utilityProcess.fork. There is no token
//     file and no attach handshake.
//   - server/routes/health.ts is auth-exempt and exactly
//     {app,pid,static,stamp}. auth.test.ts pins that key sort. Health
//     must not grow a token (FAIL 21/22).
//   - A packaged GUI that mints a *new* token cannot authorize against
//     an already-running service that keeps the token it was forked with.
//
// Therefore attach discovers the service token from a 0600 file under
// ~/.velarixbot (same isolated HOME as the rest of the suite). That is
// local filesystem, not a new network surface, and not health JSON.
// The service host (Electron --harness-service) is the only writer.
// The GUI process is read-only.
//
// Sidecar shape: {app,pid,port,token}. pid is the *server* pid (the
// utilityProcess child that answers /api/health), not the Electron
// parent. Attach's "ours" check is sidecar.pid === health.pid plus
// health app/static — not "we just forked this pid".
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const SERVICE_AUTH_FILE = "service-auth.json";
export const TOKEN_RE = /^[0-9a-f]{64}$/;

const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

export function serviceAuthPath(home = homedir()) {
  return join(home, ".velarixbot", SERVICE_AUTH_FILE);
}

function ensurePrivateDir(dir) {
  mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  try {
    chmodSync(dir, PRIVATE_DIR_MODE);
  } catch {
    /* win32 mode bits are a no-op — NTFS ACLs already scope the profile */
  }
}

function fsyncDir(dir) {
  try {
    const fd = openSync(dir, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    /* win32 cannot open directories — rename is still atomic */
  }
}

/** Crash-safe 0600 replace. Same discipline as server/atomic.ts; kept
 * local so the Electron shell does not import server TypeScript. */
export function atomicWritePrivateFile(path, data) {
  ensurePrivateDir(dirname(path));
  const temp = `${path}.${process.pid}.tmp`;
  const fd = openSync(temp, "w", PRIVATE_FILE_MODE);
  try {
    let offset = 0;
    const buf = Buffer.from(data, "utf8");
    while (offset < buf.length) offset += writeSync(fd, buf, offset);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    chmodSync(temp, PRIVATE_FILE_MODE);
  } catch {
    /* win32 */
  }
  renameSync(temp, path);
  try {
    chmodSync(path, PRIVATE_FILE_MODE);
  } catch {
    /* win32 */
  }
  fsyncDir(dirname(path));
}

export function parseServiceAuth(raw) {
  if (!raw || typeof raw !== "object") return null;
  const pid = Number(raw.pid);
  const port = Number(raw.port);
  const token = typeof raw.token === "string" ? raw.token.trim() : "";
  if (raw.app !== "velarixbot") return null;
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (!Number.isInteger(port) || port <= 0) return null;
  if (!TOKEN_RE.test(token)) return null;
  return { app: "velarixbot", pid, port, token };
}

export function readServiceAuth(home = homedir()) {
  try {
    return parseServiceAuth(JSON.parse(readFileSync(serviceAuthPath(home), "utf8")));
  } catch {
    return null;
  }
}

export function writeServiceAuth({ pid, port, token }, home = homedir()) {
  const parsed = parseServiceAuth({ app: "velarixbot", pid, port, token });
  if (!parsed) throw new Error("invalid service auth sidecar");
  // token stays out of logs / argv / health. File is 0600 under ~/.velarixbot.
  atomicWritePrivateFile(serviceAuthPath(home), `${JSON.stringify(parsed, null, 2)}\n`);
  return parsed;
}

export function removeServiceAuth(home = homedir()) {
  const path = serviceAuthPath(home);
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    /* already gone */
  }
}

/** Health stays four keys. This helper exists so tests can pin that attach
 * never copies the sidecar token onto a health-shaped object. */
export function healthWithoutSecrets(health) {
  if (!health || typeof health !== "object") return null;
  return {
    app: health.app,
    pid: health.pid,
    static: health.static,
    stamp: health.stamp,
  };
}
