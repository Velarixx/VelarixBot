// Release/build gate: the file electron/main.mjs forks must be this job's
// build:server output. A widened tsc rootDir used to emit
// dist-server/server/index.js and leave a stale flat dist-server/index.js
// in the installer — this fails that layout before a package is published.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const DIST_SERVER_DIR = join(REPO_ROOT, "dist-server");
export const BUILT_ENTRY_REL = "index.js";
export const RESOURCES_SERVER_ENTRY_REL = join("server", "index.js");
export const MAIN_FORK_RE =
  /path\.join\(\s*process\.resourcesPath\s*,\s*["']server["']\s*,\s*["']index\.js["']\s*\)/;

export function hashFile(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function packagedServerForkFromMain(source) {
  if (!MAIN_FORK_RE.test(String(source ?? ""))) {
    throw new Error('electron/main.mjs must fork path.join(process.resourcesPath, "server", "index.js")');
  }
  return RESOURCES_SERVER_ENTRY_REL;
}

export function assertBuiltServerEntry(distServer = DIST_SERVER_DIR) {
  const entry = join(distServer, BUILT_ENTRY_REL);
  const nested = join(distServer, "server", "index.js");
  const shown = (p) => relative(REPO_ROOT, p) || p;
  if (!existsSync(entry)) {
    const hint = existsSync(nested)
      ? `tsc emitted ${shown(nested)} (widened rootDir) instead of ${shown(entry)}`
      : `${shown(entry)} is missing`;
    throw new Error(`packaged server entry missing: ${hint}`);
  }
  if (existsSync(nested)) {
    throw new Error(
      `tsc also wrote ${shown(nested)}; rootDir widened. pnpm build:server must emit a flat ${BUILT_ENTRY_REL} so electron/main.mjs forks the just-built server.`,
    );
  }
  return { entry, hash: hashFile(entry), mtimeMs: statSync(entry).mtimeMs };
}

export function assertPackagedMatchesBuilt(packagedPath, expectedHash) {
  if (!existsSync(packagedPath)) {
    throw new Error(`packaged server missing at ${packagedPath} (the path main.mjs forks)`);
  }
  const actual = hashFile(packagedPath);
  if (actual !== expectedHash) {
    throw new Error(
      `packaged server is not the just-built server.\n  packaged: ${packagedPath} sha256=${actual}\n  built:    sha256=${expectedHash}`,
    );
  }
  return actual;
}

function print(msg) {
  process.stdout.write(`${msg}\n`);
}

function fail(err) {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { packaged: "", stamp: "", record: false, built: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--built") out.built = true;
    else if (a === "--record") out.record = true;
    else if (a === "--packaged") out.packaged = argv[++i] ?? "";
    else if (a === "--stamp") out.stamp = argv[++i] ?? "";
    else fail(`unknown argument: ${a}`);
  }
  return out;
}

function cli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const built = assertBuiltServerEntry();
  print(`built ${relative(REPO_ROOT, built.entry)} sha256=${built.hash}`);
  if (args.stamp && args.record) {
    writeFileSync(args.stamp, `${built.hash}\n`);
    print(`recorded stamp ${args.stamp}`);
  }
  if (args.packaged) {
    let expected = built.hash;
    if (args.stamp && existsSync(args.stamp) && !args.record) {
      expected = readFileSync(args.stamp, "utf8").trim();
    }
    assertPackagedMatchesBuilt(resolve(args.packaged), expected);
    print(`packaged ${args.packaged} matches just-built server`);
  }
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try {
    cli();
  } catch (e) {
    fail(e);
  }
}
