import { createHash } from "node:crypto";
import { chmodSync, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { get } from "node:https";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

export const CUA_DRIVER_VERSION = "0.19.3";

const DARWIN_UNIVERSAL = {
  archive: `cua-driver-rs-${CUA_DRIVER_VERSION}-darwin-universal-binary.tar.gz`,
  expected: "733e28a3782ac8d325f8fce8b5d97486c1054af755b40dfd086151b34c79377e",
  binaryName: "cua-driver",
  format: "tar.gz",
};

const WINDOWS = {
  x64: {
    archive: `cua-driver-rs-${CUA_DRIVER_VERSION}-windows-x86_64-binary.zip`,
    expected: "51a316b14ec9667c04106d8aff80d696ded427cb64cef48de09095e4709f583d",
    binaryName: "cua-driver.exe",
    format: "zip",
  },
  arm64: {
    archive: `cua-driver-rs-${CUA_DRIVER_VERSION}-windows-arm64-binary.zip`,
    expected: "a26b27ae3470f36fa4b12805caae88db510e5cd60e30522bda6b492963727701",
    binaryName: "cua-driver.exe",
    format: "zip",
  },
};

/** Artifact to fetch for this packager host. Linux is unsupported → null (caller exits 0). */
export function cuaDriverArtifact(platform = process.platform, arch = process.arch) {
  if (platform === "darwin") return { platform, arch: "universal", ...DARWIN_UNIVERSAL };
  if (platform === "win32" && arch === "arm64") return { platform, arch, ...WINDOWS.arm64 };
  if (platform === "win32") return { platform, arch: "x64", ...WINDOWS.x64 };
  return null;
}

export function cuaDriverOutputPath(resourcesDir, artifact) {
  return join(resourcesDir, artifact.binaryName);
}

function download(url) {
  return new Promise((resolve, reject) => {
    const go = (target) =>
      get(target, { headers: { "user-agent": "VelarixBot-build" } }, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return go(res.headers.location);
        }
        if (res.statusCode !== 200) return reject(new Error(`download failed: HTTP ${res.statusCode}`));
        resolve(res);
      }).on("error", reject);
    go(url);
  });
}

function findBinary(root, name) {
  const direct = join(root, name);
  if (existsSync(direct) && statSync(direct).isFile()) return direct;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name === name) return full;
    }
  }
  return null;
}

function alreadyStaged(output, artifact) {
  if (!existsSync(output)) return false;
  if (artifact.platform !== "darwin") return true;
  const probe = spawnSync("file", [output], { encoding: "utf8" });
  if (probe.status === 0 && probe.stdout.includes("universal binary")) return true;
  rmSync(output, { force: true });
  return false;
}

export async function fetchCuaDriver({
  platform = process.platform,
  arch = process.arch,
  resources = join(import.meta.dirname, "..", "electron", "resources"),
} = {}) {
  const artifact = cuaDriverArtifact(platform, arch);
  if (!artifact) return { skipped: true, reason: "unsupported-platform" };
  const output = cuaDriverOutputPath(resources, artifact);
  if (alreadyStaged(output, artifact)) return { skipped: true, reason: "already-staged", output, artifact };

  mkdirSync(resources, { recursive: true });
  const archivePath = join(resources, artifact.archive);
  const url = `https://github.com/trycua/cua/releases/download/cua-driver-rs-v${CUA_DRIVER_VERSION}/${artifact.archive}`;
  const res = await download(url);
  await new Promise((resolve, reject) => {
    const stream = createWriteStream(archivePath, { mode: 0o600 });
    res.pipe(stream);
    stream.on("finish", () => stream.close(resolve));
    stream.on("error", reject);
  });

  const actual = createHash("sha256").update(readFileSync(archivePath)).digest("hex");
  if (actual !== artifact.expected) {
    rmSync(archivePath, { force: true });
    throw new Error(`cua-driver checksum mismatch: ${actual}`);
  }

  const unpackDir = join(resources, `.cua-unpack-${artifact.arch}`);
  rmSync(unpackDir, { recursive: true, force: true });
  mkdirSync(unpackDir, { recursive: true });
  const unpack =
    artifact.format === "zip"
      ? spawnSync("tar", ["-xf", archivePath, "-C", unpackDir], { encoding: "utf8" })
      : spawnSync("tar", ["-xzf", archivePath, "-C", unpackDir], { encoding: "utf8" });
  rmSync(archivePath, { force: true });
  if (unpack.status !== 0) {
    rmSync(unpackDir, { recursive: true, force: true });
    throw new Error(unpack.stderr || "could not unpack cua-driver");
  }

  const found = findBinary(unpackDir, artifact.binaryName);
  if (!found) {
    rmSync(unpackDir, { recursive: true, force: true });
    throw new Error(`archive did not contain ${artifact.binaryName}`);
  }
  rmSync(output, { force: true });
  renameSync(found, output);
  rmSync(unpackDir, { recursive: true, force: true });
  if (artifact.platform !== "win32") chmodSync(output, 0o755);
  return { skipped: false, output, artifact };
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const result = await fetchCuaDriver();
  if (result.skipped && result.reason === "unsupported-platform") process.exit(0);
}
