import { app, BrowserWindow, Menu, Tray, desktopCapturer, dialog, ipcMain, nativeImage, safeStorage, session, shell, systemPreferences, utilityProcess } from "electron";
import { spawn } from "node:child_process";
import path, { basename, join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mintApiToken, serverUrlFilter, withAuthHeader } from "./api-auth.mjs";
import { createSecretBrokerHandler } from "./secret-broker.mjs";
import { startCua, stopCua, registerCuaIpc } from "./cua.mjs";
import { packagedLocalCuaSupported } from "./cua-connection.mjs";
import { startSpeech, stopSpeech } from "./speech.mjs";
import { startUpdater, registerUpdaterIpc } from "./updater.mjs";
import { registerNotifyIpc } from "./notify.mjs";
import { shouldQuitOnLastWindow } from "./background.mjs";
import { createRestartPolicy } from "./server-supervisor.mjs";
import { parseTrayEnabled, trayBadgeText, trayTooltip } from "./tray-settings.mjs";
import { readServiceAuth, removeServiceAuth, writeServiceAuth } from "./service-auth.mjs";
import {
  CANDIDATE_PORTS,
  decidePackagedGuiAction,
  decideServiceHostAction,
  isSpawnedChildHealth,
  runPackagedGuiBoot,
  runServiceHostBoot,
  waitForAttachable,
} from "./service-attach.mjs";
import {
  applyHarnessHostLaunch,
  applyOccupantStop,
  applyServicePlan,
  isHarnessServiceArgv,
  isWindowsServiceMissing,
  parseServiceEnabledPref,
  planHarnessHostLaunch,
  planOccupantStop,
  planServiceInstall,
  planServiceStart,
  planServiceStop,
  planServiceUninstall,
  queryWindowsService,
  removeLaunchAgentPlist,
  runEnsureUserSessionHost,
  writeLaunchAgentPlist,
} from "./service-control.mjs";
import { shouldKillServerOnBeforeQuit } from "./service-quit.mjs";

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
let serviceEnabled = true;
let guiChild = null;

// [VERIFY] 2026-08-18: HEAD forked the harness from every packaged GUI
// and killed it on Quit. The user-session service (--harness-service) is
// now the only packaged host. The GUI attaches (sidecar token + health
// app/static/pid) and must not utilityProcess.fork a second fleet.
const isService = isHarnessServiceArgv(process.argv, process.env);
const isDuplicateGui = !isService && !app.requestSingleInstanceLock();
if (isDuplicateGui) app.quit();
if (!isService) {
  app.on("second-instance", () => {
    showMainWindow();
  });
}

// Packaged: the harness server ships in Resources (compiled JS, zero deps)
// and runs on Electron's own Node via utilityProcess. It serves the built
// UI too, so the window talks to one origin and there is no dev proxy.
// A stray server on the default port must not brick the app — fall back to
// alternate ports until one binds AND identifies as ours (the probe checks
// our API shape, not just a 200). Attach additionally requires the local
// sidecar pid — pid===child is spawn-only (service host confirming its fork).
let serverProc = null;
let serverReady = true;
let harnessOwnership = "none";
// Service host mints the token and writes ~/.velarixbot/service-auth.json
// (0600). The GUI never mints: it reads the service token from that file.
// Health stays {app,pid,static,stamp} — the token is not in the JSON.
let API_TOKEN = isService ? mintApiToken() : "";
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
      // diagnostics export: the packaged server has no package.json to read
      VELARIX_APP_VERSION: app.getVersion(),
      OMB_LOCAL_CUA_SUPPORTED: packagedLocalCuaSupported(process.platform),
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
  // Spawn-only identity: pid===child. Attach uses the sidecar (see
  // service-attach.mjs) and must not treat "we just forked this pid" as ours.
  for (let i = 0; i < 40; i++) {
    if (exited) return null;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) {
        const body = await res.json().catch(() => null);
        if (isSpawnedChildHealth(body, proc.pid)) return proc;
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
    for (const port of CANDIDATE_PORTS) {
      const proc = await startServerOn(port);
      if (proc) {
        serverProc = proc;
        SERVER_PORT = port;
        writeServiceAuth({ pid: proc.pid, port, token: API_TOKEN });
        harnessOwnership = "service";
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

const STOP_PAGE =
  "data:text/html;charset=utf-8," +
  encodeURIComponent(
    `<body style="margin:0;display:flex;align-items:center;justify-content:center;height:100vh;background:#070707;color:#fcfcfc;font:15px -apple-system,system-ui"><div style="text-align:center;max-width:360px"><div style="font-size:40px">🐭</div><h2 style="font-weight:600;margin:12px 0 6px">Stopped an old bot server</h2><p style="color:#fcfcfc99;line-height:1.5">A leftover server from a previous version was using the ports. VelarixBot stopped it and is starting the new one — quit and reopen if this stays up.</p></div></body>`,
  );
let leftoverStopCard = false;

const SERVER_DOWN_PAGE =
  "data:text/html;charset=utf-8," +
  encodeURIComponent(
    `<body style="margin:0;display:flex;align-items:center;justify-content:center;height:100vh;background:#070707;color:#fcfcfc;font:15px -apple-system,system-ui"><div style="text-align:center;max-width:360px"><div style="font-size:40px">🐭</div><h2 style="font-weight:600;margin:12px 0 6px">The bot server stopped</h2><p style="color:#fcfcfc99;line-height:1.5">It kept crashing and couldn't be restarted automatically. Quit and reopen VelarixBot to try again.</p></div></body>`,
  );

// Inject the launch token on every renderer request to the server. Covers
// fetch AND EventSource (SSE, which cannot set its own headers). Re-run
// after every (re)start — a respawn can land on a different fallback port,
// and re-registering replaces the previous filter.
function registerApiAuth() {
  if (!API_TOKEN) return;
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: serverUrlFilter(SERVER_PORT) },
    (details, callback) => callback({ requestHeaders: withAuthHeader(details.requestHeaders, API_TOKEN) }),
  );
}

async function probeHealth(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function sessionUid() {
  return typeof process.getuid === "function" ? process.getuid() : 0;
}

async function attachToRunningService() {
  const found = await waitForAttachable({
    probe: probeHealth,
    readSidecar: () => readServiceAuth(),
    sleep: () => new Promise((r) => setTimeout(r, 250)),
  });
  if (!found?.sidecar?.token) return null;
  API_TOKEN = found.sidecar.token;
  SERVER_PORT = found.port;
  harnessOwnership = "attached";
  return found;
}

async function probeCandidatePorts() {
  const sidecar = readServiceAuth();
  const results = [];
  for (const port of CANDIDATE_PORTS) {
    results.push({ port, health: await probeHealth(port), sidecar });
  }
  return results;
}

function stopLeftoverOccupant(pid) {
  applyOccupantStop(planOccupantStop({ pid, platform: process.platform }));
}

async function ensureUserSessionHost({ recycle = false } = {}) {
  const exe = process.execPath;
  const uid = sessionUid();
  const platform = process.platform;
  const queried = platform === "win32" ? queryWindowsService() : null;
  const serviceMissing = platform === "win32" ? isWindowsServiceMissing(queried) : false;
  let startedOk = false;
  await runEnsureUserSessionHost(
    { platform, exePath: exe, uid, serviceMissing, recycle },
    {
      register: (plan) => {
        if (!plan || plan.action === "unsupported") return;
        if (plan.plist) writeLaunchAgentPlist({ exePath: exe, destPath: plan.plistPath });
        if (plan.bootstrap) applyServicePlan(plan.bootstrap);
        else applyServicePlan(plan);
      },
      osStop: (plan) => applyServicePlan(plan),
      osStart: (plan) => {
        const result = applyServicePlan(plan);
        startedOk = Boolean(result?.ok);
        return result;
      },
      launchHost: (plan) =>
        applyHarnessHostLaunch(plan ?? planHarnessHostLaunch({ exePath: exe }), { spawnFn: spawn }),
    },
  );
  if (!serviceMissing && !startedOk) {
    applyHarnessHostLaunch(planHarnessHostLaunch({ exePath: exe }), { spawnFn: spawn });
  }
}

async function preparePackagedGuiServer() {
  const decision = decidePackagedGuiAction(await probeCandidatePorts());
  leftoverStopCard = decision.action === "replace";
  const { found } = await runPackagedGuiBoot(decision, {
    stopOccupant: stopLeftoverOccupant,
    ensureHost: ({ serviceMissing } = {}) =>
      ensureUserSessionHost({ recycle: decision.action === "replace" && !serviceMissing }),
    attach: attachToRunningService,
  });
  return found;
}

function enableUserSessionService() {
  const exe = process.execPath;
  const uid = sessionUid();
  const install = planServiceInstall({ platform: process.platform, uid, exePath: exe });
  if (install.action === "unsupported") return false;
  if (install.plist) writeLaunchAgentPlist({ exePath: exe, destPath: install.plistPath });
  if (install.bootstrap) applyServicePlan(install.bootstrap);
  else applyServicePlan(install);
  applyServicePlan(planServiceStart({ running: false, platform: process.platform, uid }));
  return true;
}

function disableUserSessionService() {
  const uid = sessionUid();
  applyServicePlan(planServiceStop({ running: true, platform: process.platform, uid }));
  if (process.platform === "darwin") removeLaunchAgentPlist();
  if (process.platform === "win32") {
    const uninstall = planServiceUninstall({ platform: "win32", uid, running: false });
    if (uninstall.remove) applyServicePlan(uninstall.remove);
  }
}

function spawnGui() {
  if (guiChild && !guiChild.killed) return;
  const args = app.isPackaged ? [] : ["."];
  guiChild = spawn(process.execPath, args, {
    detached: true,
    stdio: "ignore",
    shell: false,
    env: Object.fromEntries(
      Object.entries(process.env).filter(([key]) => key !== "VELARIX_API_TOKEN" && key !== "VELARIX_HARNESS_SERVICE"),
    ),
  });
  guiChild.unref();
  guiChild.once("exit", () => {
    guiChild = null;
  });
}

async function runServiceHost() {
  if (IS_MAC) {
    try {
      app.dock.hide();
    } catch {
      /* older Electron */
    }
  }
  const sidecar = readServiceAuth();
  const results = [];
  for (const port of CANDIDATE_PORTS) {
    results.push({ port, health: await probeHealth(port), sidecar });
  }
  const decision = decideServiceHostAction(results);
  const { spawned } = await runServiceHostBoot(decision, {
    stopOccupant: stopLeftoverOccupant,
    spawn: startServerPackaged,
  });
  if (decision.action === "already-running") {
    app.exit(0);
    return;
  }
  serverReady = Boolean(spawned);
  if (serverReady && serverProc) superviseServer(serverProc);
  app.on("activate", () => spawnGui());
}

// Post-boot supervision (rc.12 field fix): the exit listener inside
// startServerOn only matters during startup. Without this, one bad CLI
// crashing the forked server left the window up while every bot was dead
// until app relaunch. Respawn through the crash-loop policy; when that gives
// up, say so visibly instead of a silently dead app.
const serverRestartPolicy = createRestartPolicy();

function superviseServer(proc) {
  proc.once("exit", (code) => {
    if (isQuitting || proc !== serverProc) return;
    serverProc = null;
    console.error(`[server] bot server exited unexpectedly (code ${code}) — attempting restart`);
    void respawnServer();
  });
}

async function respawnServer() {
  serverReady = false;
  if (serverRestartPolicy.shouldRestart()) {
    serverReady = await startServerPackaged();
  }
  if (mainWindow?.isDestroyed()) return;
  if (serverReady) {
    superviseServer(serverProc);
    if (serverProc?.pid && API_TOKEN) writeServiceAuth({ pid: serverProc.pid, port: SERVER_PORT, token: API_TOKEN });
    registerApiAuth();
    mainWindow?.loadURL(`http://127.0.0.1:${SERVER_PORT}`);
  } else {
    console.error("[server] bot server could not be restarted");
    mainWindow?.loadURL(SERVER_DOWN_PAGE);
  }
}

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
    win.loadURL(serverReady ? `http://127.0.0.1:${SERVER_PORT}` : leftoverStopCard ? STOP_PAGE : ERROR_PAGE);
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

function loadPrefs() {
  try {
    return JSON.parse(readFileSync(trayPrefsPath(), "utf8"));
  } catch {
    return {};
  }
}

function loadTrayEnabled() {
  return parseTrayEnabled(loadPrefs());
}

function savePrefs(patch) {
  try {
    mkdirSync(app.getPath("userData"), { recursive: true });
    const current = loadPrefs();
    const next = {
      trayEnabled: patch.trayEnabled !== undefined ? patch.trayEnabled !== false : parseTrayEnabled(current),
      serviceEnabled:
        patch.serviceEnabled !== undefined ? patch.serviceEnabled === true : parseServiceEnabledPref(current) !== false,
    };
    writeFileSync(trayPrefsPath(), JSON.stringify(next, null, 2));
  } catch (e) {
    console.error("[prefs] save failed:", e);
  }
}

function saveTrayEnabled(enabled) {
  savePrefs({ trayEnabled: enabled !== false });
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

// Local screen preview ("This Mac" / "This PC") — served from the main
// process so the Screen Recording permission prompt attributes to the app,
// never the server. desktopCapturer has no platform gate; the UI offers
// local on darwin and win32 only.
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

ipcMain.handle("login:get", () => serviceEnabled !== false);
ipcMain.handle("login:set", (_event, enabled) => {
  // Electron GUI login item is not a substitute for the user-session service.
  try {
    app.setLoginItemSettings({ openAtLogin: false });
  } catch {
    /* unpackaged / unsupported */
  }
  serviceEnabled = enabled === true;
  savePrefs({ serviceEnabled });
  if (app.isPackaged) {
    if (serviceEnabled) void ensureUserSessionHost();
    else disableUserSessionService();
  }
  return serviceEnabled;
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
  if (isDuplicateGui) return;
  if (isService) {
    await runServiceHost();
    return;
  }
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
  const prefs = loadPrefs();
  trayEnabled = parseTrayEnabled(prefs);
  const servicePref = parseServiceEnabledPref(prefs);
  serviceEnabled = servicePref !== false;
  if (app.isPackaged) {
    try {
      app.setLoginItemSettings({ openAtLogin: false });
    } catch {
      /* unsigned / unsupported */
    }
    // First packaged launch (pref unset) enables the user-session service
    // so Quit leaves routines ticking and the next OS login starts it
    // without opening the GUI.
    if (serviceEnabled && servicePref === null) savePrefs({ serviceEnabled: true });
    const attached = await preparePackagedGuiServer();
    serverReady = Boolean(attached);
    if (serverReady) registerApiAuth();
  }
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
  if (shouldKillServerOnBeforeQuit({ role: isService ? "service" : "gui", ownership: harnessOwnership })) {
    try {
      serverProc?.kill();
    } catch {}
    if (isService) removeServiceAuth();
  }
  destroyTray();
  stopCua().finally(() => {
    cuaCleanedUp = true;
    app.quit();
  });
});
