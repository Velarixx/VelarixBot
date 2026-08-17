// Pure CUA connection contract — no Electron import, so unit tests can
// fake a staged binary + socket/pipe without a live desktop or daemon.
//
// Darwin and Windows use the same MCP spawn shape:
//   cua-driver mcp [--embedded --socket <path>]
// Windows talks to a named pipe; macOS uses a unix socket. Linux is
// intentionally unsupported (no binary, no extraResources).

import path from "node:path";

export const HOST_BUNDLE_ID = "com.velarix.bot";
export const INSTALLED_DRIVER_DARWIN = "/Applications/CuaDriver.app/Contents/MacOS/cua-driver";

export function localCuaPlatformSupported(platform) {
  return platform === "darwin" || platform === "win32";
}

/** Packaged-server env: "1" on darwin/win32, "0" on Linux (and anything else). */
export function packagedLocalCuaSupported(platform) {
  return localCuaPlatformSupported(platform) ? "1" : "0";
}

export function bundledDriverNames(platform) {
  return platform === "win32" ? ["cua-driver.exe", "cua-driver"] : ["cua-driver"];
}

export function isNamedPipePath(sockPath) {
  return typeof sockPath === "string" && /(?:^|[/\\])[.][/\\]pipe[/\\]/i.test(sockPath.replaceAll("/", "\\"));
}

export function standaloneSocketPath(platform, home) {
  if (platform === "win32") return "\\\\.\\pipe\\cua-driver";
  if (platform === "darwin") return path.join(home, "Library/Caches/cua-driver/cua-driver.sock");
  return null;
}

export function installedDriverPath(platform) {
  if (platform === "darwin") return INSTALLED_DRIVER_DARWIN;
  return null;
}

export function resolveDriverBinaryWith({
  platform,
  envPath,
  packaged,
  resourcesPath,
  exists,
  installedPath = installedDriverPath(platform),
}) {
  if (envPath) return envPath;
  if (packaged && resourcesPath) {
    for (const name of bundledDriverNames(platform)) {
      const candidate = path.join(resourcesPath, name);
      if (exists(candidate)) return candidate;
    }
  }
  if (installedPath && exists(installedPath)) return installedPath;
  return null;
}

export function mcpConnection({ mode, socketPath, mcpCommand, embedded }) {
  return {
    mode,
    socketPath,
    mcpCommand,
    mcpArgs: embedded ? ["mcp", "--embedded", "--socket", socketPath] : ["mcp"],
    mcpEnv: embedded
      ? { CUA_DRIVER_EMBEDDED: "1", CUA_DRIVER_HOST_BUNDLE_ID: HOST_BUNDLE_ID }
      : {},
  };
}

/**
 * Decide the cua-connection.json descriptor.
 * `socketAlive` and `startEmbedded` are injected so tests can fake the
 * staged binary / named-pipe contract without spawning CUA.
 */
export async function resolveCuaConnection({
  platform,
  binary,
  wantEmbedded,
  socketAlive,
  startEmbedded,
  home,
}) {
  if (!localCuaPlatformSupported(platform)) {
    return {
      mode: "unavailable",
      reason: "local computer control is not available on this platform",
    };
  }
  if (!binary) {
    return { mode: "unavailable", reason: "cua-driver binary not found" };
  }
  if (wantEmbedded) {
    try {
      const conn = await startEmbedded(binary);
      return mcpConnection({
        mode: "embedded",
        socketPath: conn.socketPath,
        mcpCommand: binary,
        embedded: true,
      });
    } catch (err) {
      return {
        mode: "unavailable",
        reason: `embedded host failed: ${err?.message ?? err}`,
      };
    }
  }
  const standalone = standaloneSocketPath(platform, home);
  if (standalone && (await socketAlive(standalone))) {
    return mcpConnection({
      mode: "standalone",
      socketPath: standalone,
      mcpCommand: binary,
      embedded: false,
    });
  }
  return {
    mode: "unavailable",
    reason:
      "no running cua-driver daemon; run `cua-driver serve` or grant via `cua-driver permissions grant`",
  };
}
