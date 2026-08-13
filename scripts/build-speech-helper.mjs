import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

if (process.platform !== "darwin") process.exit(0);
const root = join(import.meta.dirname, "..");
const source = join(root, "electron", "resources", "speech-helper.swift");
const output = join(root, "electron", "resources", "speech-helper");
const scratch = mkdtempSync(join(tmpdir(), "velarix-speech-"));
try {
  const arm = join(scratch, "speech-arm64");
  const intel = join(scratch, "speech-x64");
  for (const [target, targetOutput] of [
    ["arm64-apple-macos13.0", arm],
    ["x86_64-apple-macos13.0", intel],
  ]) {
    const built = spawnSync("xcrun", ["swiftc", "-O", "-target", target, source, "-o", targetOutput], { stdio: "inherit" });
    if (built.status !== 0) process.exit(built.status ?? 1);
  }
  const merged = spawnSync("lipo", ["-create", arm, intel, "-output", output], { stdio: "inherit" });
  if (merged.status !== 0) process.exit(merged.status ?? 1);
  chmodSync(output, 0o755);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
