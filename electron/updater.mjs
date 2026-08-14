// Packaged-app updater: GitHub Releases for Velarixx/VelarixBot.
// The token is read from ~/.velarixbot/config.json or GH_TOKEN / GITHUB_TOKEN
// and used only as an Authorization header — never argv, logs, asar, or IPC.
// P1.5: config.json holds a secret:// reference; the value is unsealed from
// ~/.velarixbot/secrets.json (safeStorage entries decrypt here in main).
import { createWriteStream, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { app, ipcMain, safeStorage, shell } from "electron";
import {
  DEV_NOOP_MESSAGE,
  NO_TOKEN_MESSAGE,
  newestNewerRelease,
  pickAsset,
  publicState,
  readGithubToken,
  releasesUrl,
  tokenConfigured,
} from "./update-feed.mjs";

const UA = "VelarixBot";
let mainWindow = null;
let downloadedPath = null;
let asset = null;
const state = { status: "idle", tokenConfigured: false };

function configPath() {
  return join(homedir(), ".velarixbot", "config.json");
}

function secretsPath() {
  return join(homedir(), ".velarixbot", "secrets.json");
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
  emit();
}

async function check() {
  if (!app.isPackaged) {
    asset = null;
    downloadedPath = null;
    return setState({ status: "error", message: DEV_NOOP_MESSAGE, version: undefined, percent: undefined });
  }
  const token = currentToken();
  if (!tokenConfigured(token)) {
    asset = null;
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
      return setState({ status: "idle", message: undefined, version: undefined });
    }
    const chosen = pickAsset(newer, process.platform, process.arch);
    if (!chosen) {
      asset = null;
      return setState({
        status: "error",
        message: "No installer for this platform in the latest release.",
        version: String(newer.tag_name || newer.name || "").replace(/^v/i, "") || undefined,
      });
    }
    asset = { url: chosen.url, name: chosen.name };
    return setState({
      status: "available",
      version: String(newer.tag_name || newer.name).replace(/^v/i, ""),
      message: undefined,
    });
  } catch {
    return setState({ status: "error", message: "Couldn't reach GitHub Releases.", version: undefined });
  }
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
  if (!asset?.url || state.status === "error") return publicState(state);
  setState({ status: "downloading", percent: 0, version: state.version, message: undefined });
  try {
    const res = await fetch(asset.url, {
      headers: githubHeaders(token, { accept: "application/octet-stream" }),
      redirect: "follow",
    });
    if (!res.ok || !res.body) {
      return setState({ status: "error", message: "Download failed.", percent: undefined });
    }
    const dir = join(app.getPath("temp"), "velarixbot-updates");
    mkdirSync(dir, { recursive: true });
    const dest = join(dir, String(asset.name || "update.bin").replace(/[^A-Za-z0-9._-]/g, "_"));
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
          if (total > 0) {
            state.percent = Math.min(100, Math.round((seen / total) * 100));
            emit();
          }
          yield value;
        }
      })(),
    );
    await pipeline(nodeStream, createWriteStream(dest));
    downloadedPath = dest;
    return setState({ status: "downloaded", percent: 100, version: state.version, message: undefined });
  } catch {
    return setState({ status: "error", message: "Download failed.", percent: undefined });
  }
}

async function install() {
  if (!app.isPackaged) {
    return setState({ status: "error", message: DEV_NOOP_MESSAGE });
  }
  if (!downloadedPath) return publicState(state);
  try {
    await shell.openPath(downloadedPath);
    app.quit();
  } catch {
    return setState({ status: "error", message: "Couldn't open the installer." });
  }
}
