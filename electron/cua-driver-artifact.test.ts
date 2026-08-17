import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { CUA_DRIVER_VERSION, cuaDriverArtifact } from "../scripts/fetch-cua-driver.mjs";
import { cuaSdkPackages } from "../scripts/stage-cua-sdk.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(ROOT, path), "utf8");

describe("cua-driver fetch artifacts", () => {
  it("keeps the darwin universal binary and checksum", () => {
    const artifact = cuaDriverArtifact("darwin", "arm64");
    expect(artifact).toMatchObject({
      platform: "darwin",
      archive: `cua-driver-rs-${CUA_DRIVER_VERSION}-darwin-universal-binary.tar.gz`,
      expected: "733e28a3782ac8d325f8fce8b5d97486c1054af755b40dfd086151b34c79377e",
      binaryName: "cua-driver",
      format: "tar.gz",
    });
    expect(cuaDriverArtifact("darwin", "x64")?.archive).toBe(artifact.archive);
  });

  it("fetches Windows x64 (required) and arm64 (SDK ships it) instead of exiting", () => {
    const x64 = cuaDriverArtifact("win32", "x64");
    expect(x64).toMatchObject({
      archive: `cua-driver-rs-${CUA_DRIVER_VERSION}-windows-x86_64-binary.zip`,
      expected: "51a316b14ec9667c04106d8aff80d696ded427cb64cef48de09095e4709f583d",
      binaryName: "cua-driver.exe",
      format: "zip",
    });
    const arm64 = cuaDriverArtifact("win32", "arm64");
    expect(arm64).toMatchObject({
      archive: `cua-driver-rs-${CUA_DRIVER_VERSION}-windows-arm64-binary.zip`,
      expected: "a26b27ae3470f36fa4b12805caae88db510e5cd60e30522bda6b492963727701",
      binaryName: "cua-driver.exe",
    });
    const fetch = read("scripts/fetch-cua-driver.mjs");
    expect(fetch).not.toMatch(/if \(process\.platform !== "darwin"\) process\.exit\(0\)/);
  });

  it("does not fetch a Linux binary", () => {
    expect(cuaDriverArtifact("linux", "x64")).toBeNull();
    expect(cuaSdkPackages("linux")).toEqual([]);
  });
});

describe("cua-sdk stage packages", () => {
  it("keeps darwin arm64+x64 natives", () => {
    const names = cuaSdkPackages("darwin").map((p) => `${p.scope}/${p.name}`);
    expect(names).toEqual([
      "@trycua/cua-driver",
      "@ubjs/core",
      "@ubjs/node",
      "@trycua/cua-driver-darwin-arm64",
      "@trycua/cua-driver-darwin-x64",
    ]);
  });

  it("stages Windows x64 and optional arm64 natives", () => {
    const pkgs = cuaSdkPackages("win32");
    expect(pkgs.map((p) => `${p.scope}/${p.name}`)).toEqual([
      "@trycua/cua-driver",
      "@ubjs/core",
      "@ubjs/node",
      "@trycua/cua-driver-win32-x64-msvc",
      "@trycua/cua-driver-win32-arm64-msvc",
    ]);
    expect(pkgs.find((p) => p.name === "cua-driver-win32-x64-msvc")?.optional).toBeFalsy();
    expect(pkgs.find((p) => p.name === "cua-driver-win32-arm64-msvc")?.optional).toBe(true);
    expect(read("scripts/stage-cua-sdk.mjs")).not.toMatch(/if \(process\.platform !== "darwin"\) process\.exit\(0\)/);
  });
});
