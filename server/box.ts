// Box (box.ascii.dev) VENDOR CLIENT — consumed only by the box
// ComputerProvider (server/computer/box.ts) and the boxAgent driver; the
// rest of the harness goes through the ComputerProvider SPI and never sees
// this module. Ported from agentcal-api src/providers/box.js, reshaped
// per-bot instead of per-customer: every bot gets one persistent box, stop
// pauses billing while the disk survives, and Join always mints a FRESH
// desktop URL (stream tokens rotate on every state change — never persist
// one).
//
// Substrate facts (probed by agentcal 2026-07-24 on a live box):
//   - REST only: POST /boxes/{id}/commands runs shell synchronously.
//   - stop→archived ~5s, resume→idle ~8s; disk persists, tmux does not.
//   - X11 desktop with Chrome + Ghostty; passwordless sudo; node 24.
//   - the dedicated IP rotates across archive/resume — never persist it.
import type { AppConfig } from "./config.ts";

const BOX_API = "https://ascii.dev/api/box/v1";
const READY = new Set(["idle", "ready", "running"]);

/** Effective Box API base — the vendor URL lives HERE (and in config),
 * behind the ComputerProvider interface; nothing outside the box provider
 * may hardcode it. */
export function boxApiBase(cfg: AppConfig): string {
  const url = cfg.box?.url?.trim();
  return (url || BOX_API).replace(/\/$/, "");
}
const apiBase = boxApiBase;

function boxFetch(cfg: AppConfig, path: string, opts: RequestInit = {}) {
  return fetch(`${apiBase(cfg)}${path}`, {
    ...opts,
    headers: {
      authorization: `Bearer ${cfg.box?.token}`,
      "content-type": "application/json",
      ...(opts.headers ?? {}),
    },
  });
}

async function boxJson(cfg: AppConfig, path: string, opts: RequestInit = {}) {
  const res = await boxFetch(cfg, path, opts);
  const body: any = await res.json().catch(() => null);
  return { ok: res.ok && body?.ok !== false, status: res.status, body };
}

/** Base box name. Per-bot boxes are `<prefix>velarixbot-workspace-<botId>`;
 * shared mode (cfg.box.shared, 3.2.4/D4) uses `<prefix>velarixbot-workspace`
 * itself — one cloud computer for every bot in this install, Grok Bot-style.
 * A stale same-name box from an earlier shared session IS reused: the disk
 * persists and that is the point. (The pre-rename leftover was
 * "openmausbot-workspace" — a different name, so it never collides.) */
export const WORKSPACE_BOX_NAME = "velarixbot-workspace";

/** 3.4/D3: how long a turn waits for the shared box before failing loud. */
export const DEFAULT_LEASE_WAIT_MS = 10 * 60_000;

/** Same sanitizer for bot ids and the install's name prefix (3.2.4/D4). */
function sanitizeNamePart(value: string): string {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 48);
}

export interface BoxSharing {
  shared: boolean;
  namePrefix: string;
  leaseWaitMs: number;
}

/** Strict decode of the shared-box knobs on cfg.box. Invalid types THROW a
 * config error (like the box provider's url field) — the computer registry
 * downgrades the provider to an unavailable shadow instead of crashing boot.
 * namePrefix is sanitized like botIds; the default "" leaves today's names
 * untouched. */
export function decodeBoxSharing(cfg: AppConfig): BoxSharing {
  const b = (cfg.box ?? {}) as NonNullable<AppConfig["box"]>;
  if (b.shared !== undefined && typeof b.shared !== "boolean") {
    throw new Error("box.shared must be a boolean");
  }
  if (b.namePrefix !== undefined && typeof b.namePrefix !== "string") {
    throw new Error("box.namePrefix must be a string");
  }
  if (
    b.leaseWaitMs !== undefined &&
    (typeof b.leaseWaitMs !== "number" || !Number.isFinite(b.leaseWaitMs) || b.leaseWaitMs <= 0)
  ) {
    throw new Error("box.leaseWaitMs must be a positive number of milliseconds");
  }
  return {
    shared: b.shared === true,
    namePrefix: sanitizeNamePart(b.namePrefix ?? ""),
    leaseWaitMs: b.leaseWaitMs ?? DEFAULT_LEASE_WAIT_MS,
  };
}

/** The one shared box name for this install: `<prefix>velarixbot-workspace`. */
export function sharedBoxName(cfg: AppConfig): string {
  return `${decodeBoxSharing(cfg).namePrefix}${WORKSPACE_BOX_NAME}`;
}

/** Convenience isolation — same Box account/token, not a security boundary.
 * Shared mode collapses every bot onto the exact prefixed shared name; the
 * prefix (per install, D4) is what keeps two co-workers on one Box account
 * from silently landing on the SAME box. */
export function boxNameForBot(cfg: AppConfig, botId: string): string {
  const { shared, namePrefix } = decodeBoxSharing(cfg);
  if (shared) return `${namePrefix}${WORKSPACE_BOX_NAME}`;
  const safe = sanitizeNamePart(botId) || "bot";
  return `${namePrefix}${WORKSPACE_BOX_NAME}-${safe}`;
}

/** Per-bot working directory ON the shared box (mirrors the local
 * ~/.velarixbot/workspaces/<botId> layout). runCommand has no cwd parameter
 * and tmux does not persist across the REST commands endpoint, so the cwd
 * is re-established by wrapping each command. */
export function botBoxCwd(botId: string): string {
  return `~/workspaces/${sanitizeNamePart(botId) || "bot"}`;
}

/** Wrap a (possibly multi-line) command so it runs in the bot's own
 * workspace dir. Brace-group with newlines keeps multi-line commands and
 * trailing comments intact; `cwd` is sanitizer-output only (no quoting
 * needed, and the unquoted ~ must expand). */
export function wrapCommandInCwd(cwd: string, command: string): string {
  return `mkdir -p ${cwd} && cd ${cwd} && {\n${command}\n}`;
}

export async function runCommand(cfg: AppConfig, boxId: string, command: string, { timeoutMs = 120_000 } = {}) {
  const res = await boxFetch(cfg, `/boxes/${boxId}/commands`, {
    method: "POST",
    body: JSON.stringify({ command }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body: any = await res.json().catch(() => null);
  return {
    ok: res.ok && body?.exitCode === 0,
    exitCode: body?.exitCode ?? null,
    stdout: body?.stdout ?? "",
    stderr: body?.stderr ?? "",
  };
}

// Desktop access, in the order that actually works (agentcal probing):
//   1) VNC (POST /desktop?vnc=1) — plain WebSocket, survives P2P-blocking
//      networks; answers {provisioning:true} first, so poll for the URL.
//   2) WebRTC stream (POST /desktop) as fallback — STUN-only, can hang.
// The desktopUrl stored on the box object is NOT usable on its own.
async function mintDesktopUrl(cfg: AppConfig, boxId: string, { vncBudgetMs = 60_000 } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < vncBudgetMs) {
    const { body } = await boxJson(cfg, `/boxes/${boxId}/desktop?vnc=1`, { method: "POST" });
    const url = body?.desktopUrl ?? body?.url;
    if (url) return url;
    if (!body?.provisioning) break;
    await new Promise((r) => setTimeout(r, 3000));
  }
  const { body } = await boxJson(cfg, `/boxes/${boxId}/desktop`, { method: "POST" });
  return body?.desktopUrl ?? body?.url ?? null;
}

async function waitReady(cfg: AppConfig, boxId: string, budgetMs = 90_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < budgetMs) {
    const { body } = await boxJson(cfg, `/boxes/${boxId}`);
    const state = body?.box?.state;
    if (READY.has(state)) return body.box;
    if (state === "error") return null;
    // an archiving box can't resume until the snapshot lands — nudge after
    if (state === "archived") await boxJson(cfg, `/boxes/${boxId}/resume`, { method: "POST" });
    await new Promise((r) => setTimeout(r, 2500));
  }
  return null;
}

export async function findBox(cfg: AppConfig, botId: string) {
  const { body } = await boxJson(cfg, "/boxes");
  // exact match on the resolved name — in shared mode that is the prefixed
  // shared name, and a stale (archived) same-name box is reused on purpose:
  // the disk persists across archive/resume
  const named = boxNameForBot(cfg, botId);
  return (body?.boxes ?? []).find((b: any) => b.name === named && b.state !== "error") ?? null;
}

/** Migration helper (3.8): the old per-bot boxes this install strands when
 * shared mode is toggled on. Lists ONLY boxes under this install's prefix
 * (`<prefix>velarixbot-workspace-*`), never the exact shared name and never
 * another install's prefix — anchored startsWith keeps "dyon-…" and
 * unprefixed names disjoint in both directions. */
export async function listStaleBotBoxes(cfg: AppConfig) {
  const base = sharedBoxName(cfg);
  const { body } = await boxJson(cfg, "/boxes");
  return ((body?.boxes ?? []) as Array<{ id: string; name?: unknown; state?: string }>)
    .filter((b) => typeof b.name === "string" && b.name.startsWith(`${base}-`))
    .map((b) => ({ id: String(b.id), name: String(b.name), state: b.state ?? null }));
}

/** Confirm-gated destroy for the cleanup flow. Only ids that are CURRENTLY
 * in this install's stale per-bot list are deleted — the shared box and
 * other installs' boxes can never be named here.
 *
 * 2026-08-17 probe note: DELETE /boxes/{id} is the one vendor call agentcal
 * never probed live, and no Box token exists in this build environment to
 * probe it now. It is therefore treated as fallible end to end: a non-2xx
 * (or missing) delete endpoint surfaces as a per-box error in the result,
 * never a silent success. */
export async function destroyStaleBotBoxes(cfg: AppConfig, boxIds: string[]) {
  const stale = new Map((await listStaleBotBoxes(cfg)).map((b) => [b.id, b]));
  const destroyed: Array<{ id: string; name: string }> = [];
  const failed: Array<{ id: string; error: string }> = [];
  for (const id of [...new Set(boxIds.map(String))]) {
    const box = stale.get(id);
    if (!box) {
      failed.push({ id, error: "not one of this install's stale per-bot boxes" });
      continue;
    }
    try {
      const res = await boxJson(cfg, `/boxes/${id}`, { method: "DELETE" });
      if (res.ok) destroyed.push({ id, name: box.name });
      else failed.push({ id, error: `box delete failed (${res.status})` });
    } catch (e) {
      failed.push({ id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { destroyed, failed };
}

function boxConfigured(cfg: AppConfig) {
  return Boolean(cfg.box?.token);
}

/**
 * Find-or-create the bot's persistent box, wait for ready, run the
 * idempotent bootstrap (screenshot tooling for the computer-use bridge +
 * a tmux welcome), and mint a fresh desktop URL.
 */
export async function provisionBox(cfg: AppConfig, botId: string, botName: string) {
  if (!boxConfigured(cfg)) {
    throw new Error('box provider not enabled — add {"box":{"token":"…"}} to ~/.velarixbot/config.json');
  }
  const vmName = boxNameForBot(cfg, botId);
  let box = await findBox(cfg, botId);
  let created = false;
  // [VERIFY] 2026-08-17: create could succeed, PATCH-name was ignored, and
  // waitReady/bootstrap/mintDesktopUrl throw left the box. Compensating
  // DELETE is vendor DELETE /boxes/{id} only — never panel/SPI destroy,
  // never the shared named box, never another prefix.
  let createdId: string | null = null;
  try {
    if (!box) {
    const createRes = await boxJson(cfg, "/boxes", {
      method: "POST",
      // substrate-side backstop: archives itself (billing pauses, disk
      // survives) if every stop path dies
      body: JSON.stringify({ ttlSeconds: 8 * 60 * 60 }),
    });
    if (!createRes.ok || !createRes.body?.box?.id) throw new Error(`box create failed (${createRes.status})`);
    box = createRes.body.box;
    created = true;
    createdId = box.id;
    const named = await boxJson(cfg, `/boxes/${box.id}`, { method: "PATCH", body: JSON.stringify({ name: vmName }) });
    if (!named.ok) throw new Error(`box rename failed (${named.status})`);
  }
  const ready = await waitReady(cfg, box.id);
  if (!ready) throw new Error("box did not become ready within 90s — retry in a minute");

  // Idempotent bootstrap. Three layers:
  //   1. X11 action + capture tools (xdotool/scrot/imagemagick) — the
  //      always-works fallback for the computer tools.
  //   2. CUA (cua-computer-server, trycua) installed into /opt/ogb/venv in
  //      the BACKGROUND (first install takes minutes; nohup'd children
  //      survive the commands endpoint returning — probed by agentcal).
  //   3. computer-server started loopback-only on :8000 when installed —
  //      driven from outside via the box's run-command endpoint, so no
  //      inbound port and no tunnel is ever needed.
  const cuaInstall = [
    "sudo apt-get update -qq || true",
    "sudo apt-get install -y -qq gnome-screenshot xclip wmctrl xdotool imagemagick scrot >/dev/null 2>&1 || true",
    'curl -LsSf https://astral.sh/uv/install.sh | sh >/dev/null 2>&1 || true',
    'export PATH="$HOME/.local/bin:$PATH"',
    'sudo mkdir -p /opt/ogb && sudo chown "$(whoami)" /opt/ogb',
    "uv venv /opt/ogb/venv --python 3.13 >/dev/null 2>&1 || uv venv /opt/ogb/venv >/dev/null 2>&1 || true",
    "[ -x /opt/ogb/venv/bin/python ] && uv pip install --python /opt/ogb/venv/bin/python cua-computer-server >/dev/null 2>&1 || true",
    "[ -x /opt/ogb/venv/bin/python ] && /opt/ogb/venv/bin/python -c 'import computer_server' 2>/dev/null && touch /opt/ogb/cua-ready || true",
  ].join("; ");
  const bootstrap = [
    "command -v xdotool >/dev/null || sudo apt-get install -y -qq xdotool scrot imagemagick >/dev/null 2>&1 || true",
    `[ -f /opt/ogb/cua-ready ] || [ -f /tmp/ogb-cua-installing ] || { touch /tmp/ogb-cua-installing; nohup bash -c '${cuaInstall.replace(/'/g, "'\\''")}; rm -f /tmp/ogb-cua-installing' > /tmp/ogb-cua-install.log 2>&1 & }`,
    // start CUA computer-server (loopback only) once installed; pidfile-free
    // guard on the module name is safe here — the pattern cannot match this
    // bootstrap's own shell (agentcal's pgrep self-match trap)
    'if [ -f /opt/ogb/cua-ready ] && ! pgrep -f "computer_server" >/dev/null 2>&1; then DISPLAY=${DISPLAY:-:0} nohup /opt/ogb/venv/bin/python -m computer_server --host 127.0.0.1 --port 8000 --width 1280 --height 800 > /tmp/ogb-cua-server.log 2>&1 & fi',
    `tmux has-session -t work 2>/dev/null || tmux new-session -d -s work 'echo; echo "  ▦ ${botName.replace(/["'\\\\]/g, "")}'"'"'s computer — VelarixBot"; echo; exec bash -i'`,
    "echo bootstrapped",
  ].join("\n");
  let boot;
  for (let attempt = 0; attempt < 5; attempt++) {
    boot = await runCommand(cfg, box.id, bootstrap);
    if (boot.ok || boot.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 3000));
  }

  const joinUrl = await mintDesktopUrl(cfg, box.id);
  if (!joinUrl) throw new Error("box desktop URL was not minted");
  return { boxId: box.id, machineName: vmName, reused: !created, state: ready.state, joinUrl };
  } catch (e) {
    if (createdId && vmName !== sharedBoxName(cfg)) {
      await boxJson(cfg, `/boxes/${createdId}`, { method: "DELETE" }).catch(() => {});
    }
    throw e;
  }
}

/** Wake the bot's box and return a FRESH desktop URL. */
export async function joinBox(cfg: AppConfig, botId: string) {
  const box = await findBox(cfg, botId);
  if (!box) throw new Error("no computer yet — provision it first");
  const ready = await waitReady(cfg, box.id);
  if (!ready) throw new Error("the box did not wake in time — try again");
  return { joinUrl: await mintDesktopUrl(cfg, box.id), state: ready.state ?? null };
}

/** Archive the bot's box now (billing pauses, disk survives). */
export async function sleepBox(cfg: AppConfig, botId: string) {
  const box = await findBox(cfg, botId);
  if (!box) throw new Error("no computer for this bot");
  await boxJson(cfg, `/boxes/${box.id}/stop`, { method: "POST" }).catch(() => {});
  return { ok: true };
}

/** Owner-scoped shell for the Computer panel's console. On a shared box the
 * command runs inside the bot's own ~/workspaces/<botId> so bots don't trip
 * over each other's files by default (D2 still allows reading others'). */
export async function execOnBox(cfg: AppConfig, botId: string, command: string) {
  const box = await findBox(cfg, botId);
  if (!box) throw new Error("no computer for this bot yet");
  const ready = await waitReady(cfg, box.id, 60_000);
  if (!ready) throw new Error("box did not wake");
  const trimmed = String(command ?? "").slice(0, 4000);
  const wrapped = decodeBoxSharing(cfg).shared ? wrapCommandInCwd(botBoxCwd(botId), trimmed) : trimmed;
  const out = await runCommand(cfg, box.id, wrapped);
  return { exitCode: out.exitCode, stdout: out.stdout.slice(-4000), stderr: out.stderr.slice(-2000) };
}

// Screenshot for the Computer panel + screen-in-chat. Two hops, both
// deterministic: capture to a file on the box (scrot/import/ffmpeg chain,
// downscaled), then read it back via the files API with encoding=base64.
// Base64 over command stdout is NOT reliable (probed 2026-08-12: an
// otherwise-complete payload came back with a corrupted length) — never
// ship binary through the commands endpoint.
const SHOT_CMD = [
  "export DISPLAY=${DISPLAY:-:0}",
  "f=/tmp/ogb-panel.png",
  'scrot -o "$f" 2>/dev/null || import -window root "$f" 2>/dev/null || ffmpeg -y -f x11grab -i "$DISPLAY" -frames:v 1 "$f" >/dev/null 2>&1',
  'command -v convert >/dev/null && convert "$f" -resize 1024x "$f" 2>/dev/null || true',
  'test -s "$f" && echo captured',
].join("; ");

export async function screenshotBox(cfg: AppConfig, botId: string) {
  const box = await findBox(cfg, botId);
  if (!box) throw new Error("no computer for this bot yet");
  if (!READY.has(box.state)) throw new Error(`box is ${box.state}`);
  const out = await runCommand(cfg, box.id, SHOT_CMD, { timeoutMs: 60_000 });
  if (!/captured/.test(out.stdout)) {
    throw new Error(out.stderr.slice(0, 200) || "screen capture failed on the box");
  }
  const { ok, body } = await boxJson(cfg, `/boxes/${box.id}/files?path=/tmp/ogb-panel.png&encoding=base64`);
  const png = body?.content;
  if (!ok || typeof png !== "string" || !png) throw new Error("could not read the frame back from the box");
  return { png, format: "png" };
}

/** Read a file from the bot's box as base64. Path must be absolute. */
export async function readBoxPath(cfg: AppConfig, botId: string, filePath: string) {
  if (!filePath.startsWith("/") || filePath.includes("..")) throw new Error("path must be absolute");
  const box = await findBox(cfg, botId);
  if (!box) throw new Error("no computer for this bot yet");
  if (!READY.has(box.state)) throw new Error(`box is ${box.state}`);
  const { ok, body } = await boxJson(cfg, `/boxes/${box.id}/files?path=${encodeURIComponent(filePath)}&encoding=base64`);
  const content = body?.content;
  if (!ok || typeof content !== "string" || !content) throw new Error("could not read that file from the box");
  return { content, path: filePath };
}
