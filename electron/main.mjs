import { app, BrowserWindow, Menu, Tray, desktopCapturer, dialog, ipcMain, nativeImage, safeStorage, session, shell, systemPreferences, utilityProcess } from "electron";
import path, { basename, join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mintApiToken, serverUrlFilter, withAuthHeader } from "./api-auth.mjs";
import { createSecretBrokerHandler } from "./secret-broker.mjs";
import { startCua, stopCua, registerCuaIpc } from "./cua.mjs";
import { startSpeech, stopSpeech } from "./speech.mjs";
import { startUpdater, registerUpdaterIpc } from "./updater.mjs";
import { registerNotifyIpc } from "./notify.mjs";
import { shouldQuitOnLastWindow } from "./background.mjs";
import { parseTrayEnabled, serializeTrayPrefs, trayBadgeText, trayTooltip } from "./tray-settings.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 127.0.0.1 explicitly — vite binds IPv4; a bare "localhost" here can
// resolve to ::1 and paint a black window
const DEV_URL = process.env.ELECTRON_START_URL ?? "http://127.0.0.1:5199";
let SERVER_PORT = 8799;
const APP_ICON = path.join(__dirname, "resources/app-icon.png");
const IS_MAC = process.platform === "darwin";
let mainWindow = null;
let tray = null;
let isQuitting = false;
let trayEnabled = true;
let trayUnread = 0;

// Packaged: the harness server ships in Resources (compiled JS, zero deps)
// and runs on Electron's own Node via utilityProcess. It serves the built
// UI too, so the window talks to one origin and there is no dev proxy.
// A stray server on the default port must not brick the app — fall back to
// alternate ports until one binds AND identifies as ours (the probe checks
// our API shape, not just a 200).
let serverProc = null;
let serverReady = true;
// One capability token per app launch: every /api/* call (except the
// /api/health identity probe) requires it. The forked server learns it via
// env; the renderer never sees it — main injects the header at the network
// layer (registerApiAuth below), which also covers EventSource/SSE.
const API_TOKEN = mintApiToken();
// P1.5 SecretStore: safeStorage lives here in main only — the forked server
// brokers encrypt/decrypt over its parent port (see secret-broker.mjs).
const handleSecretMessage = createSecretBrokerHandler({
  encryptString: (s) => safeStorage.encryptString(s),
  decryptString: (b) => safeStorage.decryptString(b),
});

async function startServerOn(port) {
  const entry = path.join(process.resourcesPath, "server", "index.js");
  // isEncryptionAvailable is false on Linux without a secret store — the
  // server then uses its documented file fallback instead of the broker.
  const safeStorageReady = safeStorage.isEncryptionAvailable();
  const proc = utilityProcess.fork(entry, [], {
    env: {
      ...process.env,
      OMB_STATIC_DIR: path.join(process.resourcesPath, "ui"),
      OMB_PORT: String(port),
      OMB_USER_DATA: app.getPath("userData"),
      OMB_LOCAL_CUA_SUPPORTED: IS_MAC ? "1" : "0",
      VELARIX_API_TOKEN: API_TOKEN,
      VELARIX_SAFE_STORAGE: safeStorageReady ? "1" : "0",
    },
    stdio: "inherit",
  });
  proc.on("message", (msg) => {
    const reply = handleSecretMessage(msg);
    if (!reply) return;
    try {
      proc.postMessage(reply);
    } catch {
      /* child already gone */
    }
  });
  let exited = false;
  proc.once("exit", () => {
    exited = true;
  });
  // wait for the port to answer (fresh machine: first boot writes data dirs).
  // Identity check is by PID: a dev harness server has the same API shape,
  // so only the child we actually forked (matching pid + static serving)
  // counts as ours.
  for (let i = 0; i < 40; i++) {
    if (exited) return null;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) {
        const body = await res.json().catch(() => null);
        if (body?.app === "velarixbot" && body.pid === proc.pid && body.static) return proc;
        break; // someone else owns this port — try the next one
      }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  try {
    proc.kill();
  } catch {}
  return null;
}

async function startServerPackaged() {
  // two passes: a quit-and-reopen relaunch can race the dying instance's
  // server during teardown — one settle-and-retry covers it
  for (let attempt = 0; attempt < 2; attempt++) {
    for (const port of [8799, 18799, 28799]) {
      const proc = await startServerOn(port);
      if (proc) {
        serverProc = proc;
        SERVER_PORT = port;
        return true;
      }
    }
    await new Promise((r) => setTimeout(r, 2500));
  }
  return false;
}

const ERROR_PAGE =
  "data:text/html;charset=utf-8," +
  encodeURIComponent(
    `<body style="margin:0;display:flex;align-items:center;justify-content:center;height:100vh;background:#070707;color:#fcfcfc;font:15px -apple-system,system-ui"><div style="text-align:center;max-width:360px"><div style="font-size:40px">🐭</div><h2 style="font-weight:600;margin:12px 0 6px">Couldn't start the bot server</h2><p style="color:#fcfcfc99;line-height:1.5">Something else is using its ports. Quit and reopen VelarixBot — if it keeps happening, restart your computer.</p></div></body>`,
  );

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 900,
    minHeight: 600,
    icon: APP_ICON,
    backgroundColor: "#070707",
    ...(IS_MAC ? { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 16, y: 16 } } : {}),
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  if (app.isPackaged) {
    win.loadURL(serverReady ? `http://127.0.0.1:${SERVER_PORT}` : ERROR_PAGE);
  } else {
    win.loadURL(DEV_URL);
  }
  win.on("close", (e) => {
    if (isQuitting) return;
    if (!shouldQuitOnLastWindow({ platform: process.platform, trayEnabled: Boolean(tray) })) {
      e.preventDefault();
      win.hide();
    }
  });
  return win;
}

function trayPrefsPath() {
  return join(app.getPath("userData"), "prefs.json");
}

function loadTrayEnabled() {
  try {
    return parseTrayEnabled(JSON.parse(readFileSync(trayPrefsPath(), "utf8")));
  } catch {
    return true;
  }
}

function saveTrayEnabled(enabled) {
  try {
    mkdirSync(app.getPath("userData"), { recursive: true });
    writeFileSync(trayPrefsPath(), serializeTrayPrefs(enabled));
  } catch (e) {
    console.error("[tray] prefs save failed:", e);
  }
}

function applyTrayBadge(count) {
  trayUnread = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  if (!tray) return;
  try {
    tray.setToolTip(trayTooltip(trayUnread));
    if (process.platform === "darwin") tray.setTitle(trayBadgeText(trayUnread));
  } catch {
    /* some platforms reject setTitle */
  }
}

function destroyTray() {
  try {
    tray?.destroy();
  } catch {}
  tray = null;
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createWindow();
    startUpdater(mainWindow);
    return mainWindow;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  if (IS_MAC) app.focus({ steal: true });
  return mainWindow;
}

function createTray() {
  if (tray) return tray;
  const icon = nativeImage.createFromPath(APP_ICON);
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Show", click: () => showMainWindow() },
      { type: "separator" },
      {
        label: "Quit",
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on("click", () => showMainWindow());
  applyTrayBadge(trayUnread);
  return tray;
}

// "This Mac" screen preview — served from the main process so the Screen
// Recording permission prompt attributes to the app, never the server
ipcMain.handle("screen:frame", async () => {
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: { width: 1280, height: 800 },
  });
  return sources[0]?.thumbnail.toDataURL() ?? null;
});

// Onboarding permission checks. Status reads are free; the mic request
// pops the real TCC prompt attributed to the app.
//
// Screen Recording deliberately has NO request path here. On macOS 15+
// every pre-grant mechanism is broken: getMediaAccessStatus("screen")
// wraps CGPreflightScreenCaptureAccess, which caches per-process (stays
// "denied" for the whole session after the user grants); a helper child
// binary gets TCC-attributed to ITSELF on macOS 26, not the app, and
// plain executables no longer appear in the Settings pane at all; and
// Sequoia+ re-prompts periodically regardless, so a pre-grant expires.
// The one reliable path is the first real in-process capture
// (screen:frame above / getDisplayMedia via the handler below) — macOS
// prompts then, attributed correctly, at the moment of actual use. The
// perm:open-settings deep link stays as the repair path for denials.
ipcMain.handle("perm:status", () => ({
  mic: IS_MAC ? (systemPreferences.getMediaAccessStatus?.("microphone") ?? "unknown") : "unavailable",
}));
ipcMain.handle("perm:request-mic", async () => {
  if (!IS_MAC) return false;
  try {
    return await systemPreferences.askForMediaAccess("microphone");
  } catch {
    return false;
  }
});

// macOS never re-prompts a denied permission — the only path is System
// Settings; deep-link straight to the right privacy pane.
ipcMain.handle("perm:open-settings", (_event, pane) => {
  if (!IS_MAC) return;
  const panes = {
    mic: "Privacy_Microphone",
    screen: "Privacy_ScreenCapture",
    speech: "Privacy_SpeechRecognition",
  };
  return shell.openExternal(
    `x-apple.systempreferences:com.apple.preference.security?${panes[pane] ?? "Privacy"}`,
  );
});

ipcMain.handle("speech:start", (event) => {
  if (!IS_MAC) return;
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) startSpeech(win);
});
ipcMain.handle("speech:stop", () => {
  if (IS_MAC) stopSpeech();
});

ipcMain.handle("fs:open-files", async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showOpenDialog(win ?? undefined, {
    properties: ["openFile", "multiSelections"],
  });
  if (result.canceled) return [];
  return result.filePaths.map((p) => ({ path: p, name: basename(p) }));
});

ipcMain.handle("login:get", () => Boolean(app.getLoginItemSettings()?.openAtLogin));
ipcMain.handle("login:set", (_event, enabled) => {
  app.setLoginItemSettings({ openAtLogin: enabled === true });
  return Boolean(app.getLoginItemSettings()?.openAtLogin);
});

ipcMain.handle("tray:get", () => trayEnabled !== false);
ipcMain.handle("tray:set", (_event, enabled) => {
  trayEnabled = enabled !== false;
  saveTrayEnabled(trayEnabled);
  if (trayEnabled) {
    try {
      createTray();
    } catch (e) {
      console.error("[tray] failed:", e);
    }
  } else {
    destroyTray();
  }
  return trayEnabled;
});
ipcMain.handle("tray:setUnread", (_event, count) => {
  applyTrayBadge(count);
  return true;
});

app.whenReady().then(async () => {
  if (IS_MAC) app.dock.setIcon(APP_ICON);
  // getDisplayMedia in the renderer → this handler → ScreenCaptureKit, all
  // inside the app's own processes — the one capture path macOS reliably
  // attributes to the app (registers it in the Screen Recording pane and
  // prompts). Used by the onboarding "Enable screen preview" button.
  session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      desktopCapturer
        .getSources({ types: ["screen"] })
        .then((sources) => callback(sources[0] ? { video: sources[0] } : {}))
        .catch(() => callback({}));
    },
    { useSystemPicker: false },
  );
  registerCuaIpc();
  registerUpdaterIpc();
  registerNotifyIpc(() => mainWindow);
  // Start the CUA daemon before the window so the harness can pick up the
  // connection descriptor on first render. Never blocks window creation on
  // failure — computer use degrades to "unavailable", the rest still works.
  startCua().catch((e) => console.error("[cua] start failed:", e));
  if (app.isPackaged) {
    serverReady = await startServerPackaged();
    // Inject the launch token on every renderer request to the server —
    // registered AFTER port fallback settles so the filter matches the port
    // the window actually loads from. Covers fetch AND EventSource (SSE),
    // which cannot set its own headers.
    if (serverReady) {
      session.defaultSession.webRequest.onBeforeSendHeaders(
        { urls: serverUrlFilter(SERVER_PORT) },
        (details, callback) => callback({ requestHeaders: withAuthHeader(details.requestHeaders, API_TOKEN) }),
      );
    }
  }
  trayEnabled = loadTrayEnabled();
  if (trayEnabled) {
    try {
      createTray();
    } catch (e) {
      console.error("[tray] failed:", e);
    }
  }
  mainWindow = createWindow();
  startUpdater(mainWindow);
  app.on("activate", () => {
    showMainWindow();
  });
});

app.on("window-all-closed", () => {
  if (shouldQuitOnLastWindow({ platform: process.platform, trayEnabled: Boolean(tray) })) app.quit();
});

// EMBEDDING.md lifecycle rule: defer the first quit until the embedded
// daemon's async cleanup completes — it can't run after the host exits.
let cuaCleanedUp = false;
app.on("before-quit", (e) => {
  isQuitting = true;
  if (cuaCleanedUp) return;
  e.preventDefault();
  try {
    serverProc?.kill();
  } catch {}
  destroyTray();
  stopCua().finally(() => {
    cuaCleanedUp = true;
    app.quit();
  });
});
