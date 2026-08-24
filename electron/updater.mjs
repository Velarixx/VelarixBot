// Packaged-app updater: GitHub Releases for Velarixx/VelarixBot.
// The token is read from ~/.velarixbot/config.json or GH_TOKEN / GITHUB_TOKEN
// and used only as an Authorization header — never argv, logs, asar, or IPC.
// P1.5: config.json holds a secret:// reference; the value is unsealed from
// ~/.velarixbot/secrets.json (safeStorage entries decrypt here in main).
//
// Download verifies SHA256SUMS.txt. Install does not open the DMG/EXE:
// a helper launched with ELECTRON_RUN_AS_NODE waits for this process to
// exit, replaces the installed bundle, then relaunches.
import { spawn } from "node:child_process";
import { copyFileSync, createWriteStream, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { app, ipcMain, safeStorage } from "electron";
import {
  DEV_NOOP_MESSAGE,
  NO_TOKEN_MESSAGE,
  newestNewerRelease,
  pickAsset,
  pickChecksumAsset,
  publicState,
  readGithubToken,
  releasesUrl,
  tokenConfigured,
} from "./update-feed.mjs";
import { helperLaunch, HELPER_FAILED_MESSAGE, INSTALLING_MESSAGE, parseUpdateResult, planInstallAfterQuit } from "./update-apply.mjs";
import { planServiceStop } from "./service-control.mjs";
import { verifyDownload } from "./update-verify.mjs";

const UA = "VelarixBot";
const __dirname = dirname(fileURLToPath(import.meta.url));
let mainWindow = null;
let downloadedPath = null;
let asset = null;
let checksumAsset = null;
const state = { status: "idle", tokenConfigured: false };

function configPath() {
  return join(homedir(), ".velarixbot", "config.json");
}

function secretsPath() {
  return join(homedir(), ".velarixbot", "secrets.json");
}

function resultPath() {
  return join(app.getPath("userData"), "update-result.json");
}

function currentToken() {
  let fileText = "";
  let secretsText = "";
  try {
    fileText = readFileSync(configPath(), "utf8");
  } catch {
    /* first run */
  }
  try {
    secretsText = readFileSync(secretsPath(), "utf8");
  } catch {
    /* no stored secrets yet */
  }
  return readGithubToken(process.env, fileText, {
    fileText: secretsText,
    decrypt: (sealed) => (safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(sealed) : ""),
  });
}

function emit() {
  state.tokenConfigured = tokenConfigured(currentToken());
  const pub = publicState(state);
  try {
    mainWindow?.webContents.send("update:state", pub);
  } catch {
    /* window gone */
  }
  return pub;
}

function setState(patch) {
  Object.assign(state, patch);
  return emit();
}

function githubHeaders(token, extra = {}) {
  return {
    "user-agent": UA,
    accept: "application/vnd.github+json",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...extra,
  };
}

function consumePriorResult() {
  try {
    const prior = parseUpdateResult(readFileSync(resultPath(), "utf8"));
    unlinkSync(resultPath());
    if (prior && prior.ok === false && prior.message) {
      setState({ status: "error", message: prior.message, percent: undefined });
    }
  } catch {
    /* no leftover result */
  }
}

export function registerUpdaterIpc() {
  ipcMain.handle("update:get-state", () => {
    state.tokenConfigured = tokenConfigured(currentToken());
    return publicState(state);
  });
  ipcMain.handle("update:check", () => check());
  ipcMain.handle("update:download", () => download());
  ipcMain.handle("update:install", () => install());
}

export function startUpdater(win) {
  mainWindow = win;
  consumePriorResult();
  emit();
}

async function fetchReleaseBytes(url, token) {
  const res = await fetch(url, {
    headers: githubHeaders(token, { accept: "application/octet-stream" }),
    redirect: "follow",
  });
  if (!res.ok || !res.body) return null;
  return res;
}

async function check() {
  if (!app.isPackaged) {
    asset = null;
    checksumAsset = null;
    downloadedPath = null;
    return setState({ status: "error", message: DEV_NOOP_MESSAGE, version: undefined, percent: undefined });
  }
  const token = currentToken();
  if (!tokenConfigured(token)) {
    asset = null;
    checksumAsset = null;
    downloadedPath = null;
    return setState({ status: "error", message: NO_TOKEN_MESSAGE, version: undefined, percent: undefined });
  }
  setState({ status: "checking", message: undefined, version: undefined, percent: undefined });
  try {
    const res = await fetch(releasesUrl(), { headers: githubHeaders(token) });
    if (res.status === 401 || res.status === 403) {
      return setState({ status: "error", message: "GitHub token was rejected.", version: undefined });
    }
    if (!res.ok) {
      return setState({ status: "error", message: `GitHub Releases returned ${res.status}.`, version: undefined });
    }
    const releases = await res.json();
    const current = app.getVersion();
    const newer = newestNewerRelease(releases, current);
    if (!newer) {
      asset = null;
      checksumAsset = null;
      return setState({ status: "idle", message: undefined, version: undefined });
    }
    const chosen = pickAsset(newer, process.platform, process.arch);
    const sums = pickChecksumAsset(newer);
    if (!chosen) {
      asset = null;
      checksumAsset = null;
      return setState({
        status: "error",
        message: "No installer for this platform in the latest release.",
        version: String(newer.tag_name || newer.name || "").replace(/^v/i, "") || undefined,
      });
    }
    if (!sums?.url) {
      asset = null;
      checksumAsset = null;
      return setState({
        status: "error",
        message: "Release is missing SHA256SUMS.txt; refusing to download an unverified installer.",
        version: String(newer.tag_name || newer.name).replace(/^v/i, ""),
      });
    }
    asset = { url: chosen.url, name: chosen.name };
    checksumAsset = { url: sums.url, name: sums.name };
    return setState({
      status: "available",
      version: String(newer.tag_name || newer.name).replace(/^v/i, ""),
      message: undefined,
    });
  } catch {
    return setState({ status: "error", message: "Couldn't reach GitHub Releases.", version: undefined });
  }
}

async function downloadTo(dest, res, onBytes) {
  try {
    unlinkSync(dest);
  } catch {
    /* first download */
  }
  const total = Number(res.headers.get("content-length") || 0);
  let seen = 0;
  const reader = res.body.getReader();
  const nodeStream = Readable.from(
    (async function* () {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        seen += value.byteLength;
        if (typeof onBytes === "function") onBytes(seen, total);
        yield value;
      }
    })(),
  );
  await pipeline(nodeStream, createWriteStream(dest));
}

async function download() {
  if (!app.isPackaged) {
    return setState({ status: "error", message: DEV_NOOP_MESSAGE });
  }
  const token = currentToken();
  if (!tokenConfigured(token)) {
    return setState({ status: "error", message: NO_TOKEN_MESSAGE });
  }
  if (!asset?.url) await check();
  if (!asset?.url || !checksumAsset?.url || state.status === "error") return publicState(state);
  setState({ status: "downloading", percent: 0, version: state.version, message: undefined });
  const dir = join(app.getPath("temp"), "velarixbot-updates");
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, String(asset.name || "update.bin").replace(/[^A-Za-z0-9._-]/g, "_"));
  const sumsDest = join(dir, "SHA256SUMS.txt");
  try {
    const sumsRes = await fetchReleaseBytes(checksumAsset.url, token);
    if (!sumsRes) {
      return setState({ status: "error", message: "Couldn't download SHA256SUMS.txt.", percent: undefined });
    }
    await downloadTo(sumsDest, sumsRes);
    const sumsText = readFileSync(sumsDest, "utf8");
    const res = await fetchReleaseBytes(asset.url, token);
    if (!res) {
      return setState({ status: "error", message: "Download failed.", percent: undefined });
    }
    await downloadTo(dest, res, (seen, total) => {
      if (total > 0) {
        state.percent = Math.min(100, Math.round((seen / total) * 100));
        emit();
      }
    });
    const verified = await verifyDownload({ filePath: dest, assetName: asset.name, sumsText });
    if (!verified.ok) {
      try {
        unlinkSync(dest);
      } catch {
        /* already gone */
      }
      downloadedPath = null;
      return setState({ status: "error", message: verified.message, percent: undefined });
    }
    downloadedPath = dest;
    return setState({ status: "downloaded", percent: 100, version: state.version, message: undefined });
  } catch {
    return setState({ status: "error", message: "Download failed.", percent: undefined });
  }
}

function sessionUid() {
  return typeof process.getuid === "function" ? process.getuid() : 0;
}

function launchInstallHelper() {
  const dir = join(app.getPath("temp"), "velarixbot-updates");
  mkdirSync(dir, { recursive: true });
  const helperDest = join(dir, "update-helper.mjs");
  const applyDest = join(dir, "update-apply.mjs");
  copyFileSync(join(__dirname, "update-helper.mjs"), helperDest);
  copyFileSync(join(__dirname, "update-apply.mjs"), applyDest);
  const stop = planServiceStop({ running: true, platform: process.platform, uid: sessionUid() });
  const plan = planInstallAfterQuit({
    platform: process.platform,
    execPath: process.execPath,
    artifactPath: downloadedPath,
    waitPid: process.pid,
    resultPath: resultPath(),
    stopCommand: stop.command ?? null,
    stopArgs: stop.args ?? [],
  });
  if (!plan.ok) return { ok: false, message: plan.message };
  const planPath = join(dir, "update-plan.json");
  writeFileSync(planPath, JSON.stringify(plan));
  const launch = helperLaunch({
    execPath: process.execPath,
    helperPath: helperDest,
    planPath,
    env: process.env,
  });
  const child = spawn(launch.command, launch.args, {
    detached: launch.detached,
    stdio: launch.stdio,
    shell: false,
    env: launch.env,
    windowsHide: true,
  });
  child.unref();
  return { ok: true };
}

async function install() {
  if (!app.isPackaged) {
    return setState({ status: "error", message: DEV_NOOP_MESSAGE });
  }
  if (!downloadedPath) return publicState(state);
  setState({ status: "installing", message: INSTALLING_MESSAGE, version: state.version });
  try {
    const launched = launchInstallHelper();
    if (!launched.ok) {
      return setState({ status: "error", message: launched.message ?? HELPER_FAILED_MESSAGE });
    }
    app.quit();
  } catch {
    return setState({ status: "error", message: HELPER_FAILED_MESSAGE });
  }
}
