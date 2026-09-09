// Packaged-app updater: GitHub Releases for Velarixx/VelarixBot.
// The token is read from ~/.velarixbot/config.json or GH_TOKEN / GITHUB_TOKEN
// and used only as an Authorization header — never argv, logs, asar, or IPC.
// P1.5: config.json holds a secret:// reference; the value is unsealed from
// ~/.velarixbot/secrets.json (safeStorage entries decrypt here in main).
//
// Download verifies SHA256SUMS.txt. Install does not open the DMG/EXE:
// helper scripts and a runnable interpreter are copied outside the
// installed .app, then launched detached (new session, shell: false)
// with ELECTRON_RUN_AS_NODE. The helper waits for this process to
// exit, runs the #147 stop gate, replaces the bundle, then relaunches.
import { spawn } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { app, ipcMain, safeStorage } from "electron";
import {
  compareVersions,
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
import {
  HELPER_FAILED_MESSAGE,
  INSTALLING_MESSAGE,
  UPDATE_INTERRUPTED_MESSAGE,
  helperLaunch,
  installedBundlePath,
  nextLaunchUpdaterState,
  parseUpdateResult,
  planHelperStaging,
  planInstallAfterQuit,
} from "./update-apply.mjs";
import { writeHarnessBootSuppress } from "./harness-boot-suppress.mjs";
import { planServiceStop } from "./service-control.mjs";
import {
  hashesEqual,
  parseVerifiedDownloadRecord,
  restoreVerifiedDownload,
  serializeVerifiedDownloadRecord,
  sha256File,
  sha256FileSync,
  verifiedDownloadRecordPath,
  verifyDownload,
} from "./update-verify.mjs";

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

function persistPath() {
  return verifiedDownloadRecordPath(app.getPath("userData"));
}

function writeUpdateResult(result) {
  writeFileSync(resultPath(), JSON.stringify(result));
}

function readVerifiedDownloadRecord() {
  try {
    return parseVerifiedDownloadRecord(readFileSync(persistPath(), "utf8"));
  } catch {
    return null;
  }
}

function writeVerifiedDownloadRecord(record) {
  writeFileSync(persistPath(), serializeVerifiedDownloadRecord(record));
}

function clearVerifiedDownloadRecord() {
  try {
    unlinkSync(persistPath());
  } catch {
    /* none persisted */
  }
}

async function tryRestoreVerifiedDownload({ availableVersion } = {}) {
  const record = readVerifiedDownloadRecord();
  if (!record) return { ok: false };
  if (availableVersion && record.version && record.version !== availableVersion) return { ok: false };
  const restored = await restoreVerifiedDownload(record, {
    fileExists: (filePath) => existsSync(filePath),
    sha256Of: (filePath) => sha256File(filePath),
  });
  if (!restored.ok) return restored;
  if (!availableVersion && restored.version && compareVersions(restored.version, app.getVersion()) <= 0) {
    clearVerifiedDownloadRecord();
    return { ok: false };
  }
  return restored;
}

function tryRestoreVerifiedDownloadSync() {
  const record = readVerifiedDownloadRecord();
  if (!record || !existsSync(record.path)) return { ok: false };
  try {
    if (!hashesEqual(sha256FileSync(record.path), record.sha256)) return { ok: false };
  } catch {
    return { ok: false };
  }
  if (record.version && compareVersions(record.version, app.getVersion()) <= 0) {
    clearVerifiedDownloadRecord();
    return { ok: false };
  }
  return { ok: true, ...record };
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
    return prior;
  } catch {
    return null;
  }
}

function bootUpdaterState() {
  const prior = consumePriorResult();
  const restored = tryRestoreVerifiedDownloadSync();
  const initial = nextLaunchUpdaterState({ priorResult: prior, restoredDownload: restored });
  if (initial.clearPersist) clearVerifiedDownloadRecord();
  downloadedPath = initial.downloadedPath;
  if (restored.ok && restored.assetName) {
    asset = { ...(asset ?? {}), name: restored.assetName, url: asset?.url };
  }
  if (initial.status === "error") {
    return setState({
      status: "error",
      message: initial.message,
      version: initial.version,
      percent: undefined,
    });
  }
  if (initial.status === "downloaded") {
    return setState({
      status: "downloaded",
      version: initial.version,
      percent: 100,
      message: undefined,
    });
  }
  return emit();
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
  bootUpdaterState();
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
      downloadedPath = null;
      clearVerifiedDownloadRecord();
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
    const version = String(newer.tag_name || newer.name).replace(/^v/i, "");
    const reused = await tryRestoreVerifiedDownload({ availableVersion: version });
    if (reused.ok) {
      downloadedPath = reused.path;
      return setState({ status: "downloaded", percent: 100, version, message: undefined });
    }
    return setState({
      status: "available",
      version,
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
  const reused = await tryRestoreVerifiedDownload({ availableVersion: state.version });
  if (reused.ok) {
    downloadedPath = reused.path;
    return setState({ status: "downloaded", percent: 100, version: state.version, message: undefined });
  }
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
      clearVerifiedDownloadRecord();
      return setState({ status: "error", message: verified.message, percent: undefined });
    }
    downloadedPath = dest;
    writeVerifiedDownloadRecord({
      path: dest,
      sha256: verified.sha256,
      version: state.version,
      assetName: asset.name,
    });
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
  const destPath = installedBundlePath({ platform: process.platform, execPath: process.execPath });
  const staged = planHelperStaging({
    platform: process.platform,
    execPath: process.execPath,
    destPath,
    helperDir: dir,
  });
  if (!staged.ok) return { ok: false, message: staged.message ?? HELPER_FAILED_MESSAGE };
  const helperDest = join(dir, "update-helper.mjs");
  copyFileSync(join(__dirname, "update-helper.mjs"), helperDest);
  copyFileSync(join(__dirname, "update-apply.mjs"), join(dir, "update-apply.mjs"));
  copyFileSync(join(__dirname, "harness-boot-suppress.mjs"), join(dir, "harness-boot-suppress.mjs"));
  if (staged.copyInterpreter) {
    try {
      copyFileSync(staged.copyFrom, staged.command);
      chmodSync(staged.command, 0o755);
    } catch {
      writeUpdateResult({ ok: false, message: HELPER_FAILED_MESSAGE });
      return { ok: false, message: HELPER_FAILED_MESSAGE };
    }
  }
  const stop = planServiceStop({ running: true, platform: process.platform, uid: sessionUid() });
  const plan = planInstallAfterQuit({
    platform: process.platform,
    execPath: process.execPath,
    artifactPath: downloadedPath,
    waitPid: process.pid,
    resultPath: resultPath(),
    stopCommand: stop.command ?? null,
    stopArgs: stop.args ?? [],
    home: process.env.HOME,
  });
  if (!plan.ok) {
    writeUpdateResult({ ok: false, message: plan.message });
    return { ok: false, message: plan.message };
  }
  const planPath = join(dir, "update-plan.json");
  writeFileSync(planPath, JSON.stringify(plan));
  writeUpdateResult({ ok: false, message: UPDATE_INTERRUPTED_MESSAGE });
  const launch = helperLaunch({
    command: staged.command,
    helperPath: helperDest,
    planPath,
    destPath: plan.destPath,
    platform: process.platform,
    env: process.env,
  });
  if (!launch.ok) {
    writeUpdateResult({ ok: false, message: launch.message ?? HELPER_FAILED_MESSAGE });
    return { ok: false, message: launch.message ?? HELPER_FAILED_MESSAGE };
  }
  try {
    const child = spawn(launch.command, launch.args, {
      detached: launch.detached,
      stdio: launch.stdio,
      shell: false,
      env: launch.env,
      windowsHide: true,
    });
    child.on("error", () => {
      try {
        writeUpdateResult({ ok: false, message: HELPER_FAILED_MESSAGE });
      } catch {
        /* GUI may already be quitting */
      }
    });
    child.unref();
    return { ok: true };
  } catch {
    writeUpdateResult({ ok: false, message: HELPER_FAILED_MESSAGE });
    return { ok: false, message: HELPER_FAILED_MESSAGE };
  }
}

async function install() {
  if (!app.isPackaged) {
    return setState({ status: "error", message: DEV_NOOP_MESSAGE });
  }
  if (!downloadedPath) {
    const restored = await tryRestoreVerifiedDownload({ availableVersion: state.version });
    if (restored.ok) downloadedPath = restored.path;
  }
  if (!downloadedPath) return publicState(state);
  setState({ status: "installing", message: INSTALLING_MESSAGE, version: state.version });
  try {
    if (process.platform === "darwin") writeHarnessBootSuppress({ home: process.env.HOME });
    const launched = launchInstallHelper();
    if (!launched.ok) {
      writeUpdateResult({ ok: false, message: launched.message ?? HELPER_FAILED_MESSAGE });
      return setState({ status: "error", message: launched.message ?? HELPER_FAILED_MESSAGE });
    }
    app.quit();
  } catch {
    writeUpdateResult({ ok: false, message: HELPER_FAILED_MESSAGE });
    return setState({ status: "error", message: HELPER_FAILED_MESSAGE });
  }
}
