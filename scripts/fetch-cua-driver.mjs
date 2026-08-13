import { createHash } from "node:crypto";
import { chmodSync, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { get } from "node:https";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const version = "0.19.3";
const archive = `cua-driver-rs-${version}-darwin-universal-binary.tar.gz`;
const expected = "733e28a3782ac8d325f8fce8b5d97486c1054af755b40dfd086151b34c79377e";
const resources = join(import.meta.dirname, "..", "electron", "resources");
const output = join(resources, "cua-driver");
const archivePath = join(resources, archive);

if (process.platform !== "darwin") process.exit(0);
if (existsSync(output)) {
  const probe = spawnSync("file", [output], { encoding: "utf8" });
  if (probe.status === 0 && probe.stdout.includes("universal binary")) process.exit(0);
  rmSync(output, { force: true });
}

mkdirSync(resources, { recursive: true });
const url = `https://github.com/trycua/cua/releases/download/cua-driver-rs-v${version}/${archive}`;
await new Promise((resolve, reject) => {
  const download = (target) => get(target, { headers: { "user-agent": "VelarixBot-build" } }, (res) => {
    if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      res.resume();
      return download(res.headers.location);
    }
    if (res.statusCode !== 200) return reject(new Error(`download failed: HTTP ${res.statusCode}`));
    const stream = createWriteStream(archivePath, { mode: 0o600 });
    res.pipe(stream);
    stream.on("finish", () => stream.close(resolve));
    stream.on("error", reject);
  }).on("error", reject);
  download(url);
});

const actual = createHash("sha256").update(readFileSync(archivePath)).digest("hex");
if (actual !== expected) {
  rmSync(archivePath, { force: true });
  throw new Error(`cua-driver checksum mismatch: ${actual}`);
}
const unpack = spawnSync("tar", ["-xzf", archivePath, "-C", resources], { encoding: "utf8" });
rmSync(archivePath, { force: true });
if (unpack.status !== 0) throw new Error(unpack.stderr || "could not unpack cua-driver");
const candidates = [join(resources, "cua-driver"), join(resources, `cua-driver-rs-${version}-darwin-universal-binary`, "cua-driver")];
const found = candidates.find(existsSync);
if (!found) throw new Error("archive did not contain cua-driver");
if (found !== output) {
  const move = spawnSync("mv", [found, output], { encoding: "utf8" });
  if (move.status !== 0) throw new Error(move.stderr || "could not place cua-driver");
}
chmodSync(output, 0o755);
