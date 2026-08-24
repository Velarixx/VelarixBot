// CUA computer-use wiring for the Electron main process.
//
// Two modes, per cua-driver's EMBEDDING.md:
//  - "embedded" (packaged app): spawn our own private daemon via
//    EmbeddedCuaDriverHost so TCC grants attribute to VelarixBot and the
//    driver inherits them. One prompt, named VelarixBot, out of the box.
//    Windows uses the same host; the SDK returns a named-pipe path.
//  - "standalone" (dev): attach to an already-installed CuaDriver daemon
//    (unix socket on macOS, named pipe on Windows).
//
// Agents never talk to the daemon socket directly — they spawn the official
// stdio MCP proxy: `cua-driver mcp [--embedded --socket <path>]`. The proxy
// executes nothing; the host-owned daemon does.
//
// The resulting connection descriptor is written to
// <userData>/cua-connection.json for the harness server to hand to drivers.

import { app, ipcMain } from "electron";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  HOST_BUNDLE_ID,
  deferredCuaConnection,
  isNamedPipePath,
  resolveCuaConnection,
  resolveDriverBinaryWith,
} from "./cua-connection.mjs";

let embeddedHost = null; // EmbeddedCuaDriverHost | null
let connection = null; // descriptor exposed to harness + renderer
let ensurePromise = null;

function saveConnection() {
  fs.mkdirSync(app.getPath("userData"), { recursive: true });
  fs.writeFileSync(
    path.join(app.getPath("userData"), "cua-connection.json"),
    JSON.stringify(connection, null, 2),
  );
  return connection;
}

export function resolveDriverBinary() {
  return resolveDriverBinaryWith({
    platform: process.platform,
    envPath: process.env.CUA_DRIVER_PATH,
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    exists: (p) => fs.existsSync(p),
  });
}

function socketAlive(sockPath) {
  return new Promise((resolve) => {
    if (!isNamedPipePath(sockPath) && !fs.existsSync(sockPath)) return resolve(false);
    const s = net.createConnection(sockPath);
    const done = (ok) => {
      s.destroy();
      resolve(ok);
    };
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
    setTimeout(() => done(false), 1500).unref();
  });
}

async function startEmbedded(binary) {
  // Dynamic import: the SDK ships a native FFI lib; keep dev startup
  // resilient if it fails to load on this machine.
  const sdkEntry = app.isPackaged
    ? pathToFileURL(path.join(process.resourcesPath, "cua-sdk", "node_modules", "@trycua", "cua-driver", "dist", "embedded.js")).href
    : "@trycua/cua-driver/embedded";
  const { EmbeddedCuaDriverHost } = await import(sdkEntry);
  embeddedHost = new EmbeddedCuaDriverHost(binary, HOST_BUNDLE_ID);
  return embeddedHost.start();
}

export function prepareDeferredCua() {
  connection = deferredCuaConnection();
  return saveConnection();
}

export async function startCua() {
  connection = await resolveCuaConnection({
    platform: process.platform,
    binary: resolveDriverBinary(),
    wantEmbedded: app.isPackaged || process.env.OPENMAUSBOT_CUA_EMBEDDED === "1",
    socketAlive,
    startEmbedded,
    home: app.getPath("home"),
  });
  return saveConnection();
}

/** Start the local computer daemon only when a feature needs it.
 * Launch and ordinary text chat must not spawn cua-driver (TCC prompts). */
export function ensureCua() {
  if (connection?.mode === "embedded" || connection?.mode === "standalone") {
    return Promise.resolve(connection);
  }
  if (!ensurePromise) {
    ensurePromise = startCua().finally(() => {
      ensurePromise = null;
    });
  }
  return ensurePromise;
}

export function cuaPermissionsStatus() {
  const binary = resolveDriverBinary();
  if (!binary) return { available: false };
  const out = spawnSync(binary, ["permissions", "status", "--json"], {
    encoding: "utf8",
    timeout: 5000,
    windowsHide: true,
  });
  try {
    return { available: true, ...JSON.parse(out.stdout) };
  } catch {
    return { available: true, raw: out.stdout?.trim() };
  }
}

export async function stopCua() {
  if (embeddedHost) {
    try {
      await embeddedHost.stop();
      embeddedHost.uniffiDestroy?.();
    } catch {
      // daemon holds a parent-liveness pipe; host death closes it anyway
    }
    embeddedHost = null;
  }
}

export function registerCuaIpc() {
  ipcMain.handle("cua:connection", () => connection);
  ipcMain.handle("cua:permissions", () => cuaPermissionsStatus());
  ipcMain.handle("cua:ensure", () => ensureCua());
}
