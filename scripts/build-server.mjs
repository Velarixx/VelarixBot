// Compile the harness server to dist-server/index.js — the path
// electron/main.mjs forks after electron-builder copies dist-server → server.
// Cleans the out dir first so a previous nested emit cannot linger.
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { DIST_SERVER_DIR, assertBuiltServerEntry } from "./verify-packaged-server.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const tsc = join(ROOT, "node_modules", "typescript", "bin", "tsc");

rmSync(DIST_SERVER_DIR, { recursive: true, force: true });
const compiled = spawnSync(process.execPath, [tsc, "-p", "tsconfig.server.build.json"], {
  cwd: ROOT,
  stdio: "inherit",
});
if (compiled.status !== 0) process.exit(compiled.status ?? 1);
const built = assertBuiltServerEntry();
process.stdout.write(`build:server ${built.entry}\n`);
