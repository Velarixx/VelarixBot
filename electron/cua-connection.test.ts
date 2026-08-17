import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  bundledDriverNames,
  isNamedPipePath,
  localCuaPlatformSupported,
  mcpConnection,
  packagedLocalCuaSupported,
  resolveCuaConnection,
  resolveDriverBinaryWith,
  standaloneSocketPath,
} from "./cua-connection.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("local CUA platform support", () => {
  it("enables darwin and win32, leaves linux unsupported", () => {
    expect(localCuaPlatformSupported("darwin")).toBe(true);
    expect(localCuaPlatformSupported("win32")).toBe(true);
    expect(localCuaPlatformSupported("linux")).toBe(false);
    expect(packagedLocalCuaSupported("darwin")).toBe("1");
    expect(packagedLocalCuaSupported("win32")).toBe("1");
    expect(packagedLocalCuaSupported("linux")).toBe("0");
  });

  it("does not hard-disable win32 in cua.mjs", () => {
    const source = readFileSync(join(ROOT, "electron", "cua.mjs"), "utf8");
    expect(source).not.toMatch(/if\s*\(\s*process\.platform\s*===\s*"win32"\s*\)/);
    expect(source).not.toMatch(/not available in the first Windows release/);
    expect(source).toContain("resolveCuaConnection");
  });

  it("sets packaged OMB_LOCAL_CUA_SUPPORTED from the platform helper, not IS_MAC alone", () => {
    const main = readFileSync(join(ROOT, "electron", "main.mjs"), "utf8");
    expect(main).toContain("packagedLocalCuaSupported(process.platform)");
    expect(main).not.toMatch(/OMB_LOCAL_CUA_SUPPORTED:\s*IS_MAC\s*\?\s*"1"\s*:\s*"0"/);
  });
});

describe("win32 cua connection from a faked binary/socket contract", () => {
  it("becomes standalone when a staged exe and named pipe are present", async () => {
    const binary = "C:\\\\VelarixBot\\\\resources\\\\cua-driver.exe";
    const conn = await resolveCuaConnection({
      platform: "win32",
      binary,
      wantEmbedded: false,
      home: "C:\\\\Users\\\\test",
      socketAlive: async (sock) => sock === "\\\\.\\pipe\\cua-driver",
      startEmbedded: async () => {
        throw new Error("must not start a live CUA host in tests");
      },
    });
    expect(conn.mode).not.toBe("unavailable");
    expect(conn).toMatchObject({
      mode: "standalone",
      socketPath: "\\\\.\\pipe\\cua-driver",
      mcpCommand: binary,
      mcpArgs: ["mcp"],
    });
    expect(isNamedPipePath(conn.socketPath)).toBe(true);
  });

  it("becomes embedded when the host returns a named-pipe contract", async () => {
    const binary = "C:\\\\VelarixBot\\\\resources\\\\cua-driver.exe";
    const conn = await resolveCuaConnection({
      platform: "win32",
      binary,
      wantEmbedded: true,
      home: "C:\\\\Users\\\\test",
      socketAlive: async () => false,
      startEmbedded: async () => ({ socketPath: "\\\\.\\pipe\\velarix-cua-embedded" }),
    });
    expect(conn.mode).toBe("embedded");
    expect(conn.mcpArgs).toEqual(["mcp", "--embedded", "--socket", "\\\\.\\pipe\\velarix-cua-embedded"]);
    expect(conn.mcpEnv).toMatchObject({ CUA_DRIVER_EMBEDDED: "1" });
  });

  it("resolves the packaged Windows exe from extraResources", () => {
    const found = resolveDriverBinaryWith({
      platform: "win32",
      packaged: true,
      resourcesPath: "C:\\\\VelarixBot\\\\resources",
      exists: (p) => p.endsWith("cua-driver.exe"),
    });
    expect(found).toBe(join("C:\\\\VelarixBot\\\\resources", "cua-driver.exe"));
    expect(bundledDriverNames("win32")).toEqual(["cua-driver.exe", "cua-driver"]);
  });
});

describe("darwin cua connection is unchanged", () => {
  it("uses the Library socket and cua-driver name", async () => {
    expect(bundledDriverNames("darwin")).toEqual(["cua-driver"]);
    expect(standaloneSocketPath("darwin", "/Users/ada")).toBe(
      "/Users/ada/Library/Caches/cua-driver/cua-driver.sock",
    );
    const conn = await resolveCuaConnection({
      platform: "darwin",
      binary: "/Applications/CuaDriver.app/Contents/MacOS/cua-driver",
      wantEmbedded: false,
      home: "/Users/ada",
      socketAlive: async (sock) => sock.endsWith("cua-driver.sock"),
      startEmbedded: async () => {
        throw new Error("must not start a live CUA host in tests");
      },
    });
    expect(conn.mode).toBe("standalone");
    expect(conn.mcpArgs).toEqual(["mcp"]);
    expect(conn.socketPath).toMatch(/cua-driver\.sock$/);
  });

  it("embedded MCP args stay --embedded --socket", () => {
    const conn = mcpConnection({
      mode: "embedded",
      socketPath: "/tmp/cua.sock",
      mcpCommand: "/res/cua-driver",
      embedded: true,
    });
    expect(conn.mcpArgs).toEqual(["mcp", "--embedded", "--socket", "/tmp/cua.sock"]);
  });
});

describe("linux stays unsupported", () => {
  it("does not claim a connection even with a fake binary", async () => {
    const conn = await resolveCuaConnection({
      platform: "linux",
      binary: "/usr/bin/cua-driver",
      wantEmbedded: true,
      home: "/home/ada",
      socketAlive: async () => true,
      startEmbedded: async () => ({ socketPath: "/tmp/cua.sock" }),
    });
    expect(conn.mode).toBe("unavailable");
    expect(conn.reason).toMatch(/not available on this platform/);
    expect(standaloneSocketPath("linux", "/home/ada")).toBeNull();
  });
});
