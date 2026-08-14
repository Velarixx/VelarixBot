// Stage better-sqlite3 for the packaged app (the P0.4 packaging hazard).
//
// The installer ships NO node_modules for the server (extraResources = dist
// + dist-server only), and better-sqlite3 is a native addon. better-sqlite3
// v12+ is an N-API module and ships prebuilt binaries for every platform
// inside the npm package (prebuilds/<platform>-<arch>.node); N-API binaries
// are ABI-stable across Node and Electron, so ONE staged copy serves:
//   - the packaged Electron app (utilityProcess fork of resources/server)
//   - the release smoke, which boots the same tree under plain node
//
// This script copies the wrapper (package.json + lib/) plus exactly the
// target platform's prebuild into build/generated-server-deps/better-sqlite3;
// electron-builder's extraResources maps that to resources/server-deps, the
// sibling directory server/db/sqlite-native.ts resolves at runtime.
//
// Fails loudly when anything is missing — a package that would crash only
// in the installer is a ship-blocker, never a warning.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(import.meta.dirname, "..");
export const SOURCE_PACKAGE = join(ROOT, "node_modules", "better-sqlite3");
export const STAGED_DIR = join(ROOT, "build", "generated-server-deps", "better-sqlite3");

export function prebuildName(platform, arch) {
  // linux CI stages linux-x64; packaging targets are darwin-arm64 (no Intel
  // mac) and win32-x64 — always the packager's native platform/arch
  return `${platform}-${arch}.node`;
}

/**
 * Copy the self-contained better-sqlite3 package (wrapper + one prebuild)
 * into targetDir. Throws when the source tree or the prebuild is missing.
 */
export function stageSqlite({
  targetDir = STAGED_DIR,
  sourceDir = SOURCE_PACKAGE,
  platform = process.platform,
  arch = process.arch,
} = {}) {
  const pkgJson = join(sourceDir, "package.json");
  if (!existsSync(pkgJson)) {
    throw new Error(`better-sqlite3 not installed at ${sourceDir} — run pnpm install --frozen-lockfile first`);
  }
  const pkg = JSON.parse(readFileSync(pkgJson, "utf8"));
  const binary = join(sourceDir, "prebuilds", prebuildName(platform, arch));
  if (!existsSync(binary)) {
    throw new Error(
      `better-sqlite3@${pkg.version} has no prebuild for ${platform}-${arch} at ${binary}. ` +
        `Packaging would produce an installer that crashes at boot — refusing.`,
    );
  }
  // the wrapper requires only node builtins (fs/path/util); anything beyond
  // that would need its own staging and must fail packaging instead
  const bareRequires = [...readWrapperSource(sourceDir).matchAll(/require\((["'])([^./][^"']*)\1\)/g)]
    .map((m) => m[2])
    .filter((spec) => !isBuiltin(spec));
  if (bareRequires.length) {
    throw new Error(`better-sqlite3 wrapper now requires non-builtin modules (${bareRequires.join(", ")}) — staging must be extended`);
  }

  rmSync(targetDir, { recursive: true, force: true });
  mkdirSync(join(targetDir, "prebuilds"), { recursive: true });
  cpSync(pkgJson, join(targetDir, "package.json"), { dereference: true });
  cpSync(join(sourceDir, "lib"), join(targetDir, "lib"), { recursive: true, dereference: true });
  if (existsSync(join(sourceDir, "LICENSE"))) {
    cpSync(join(sourceDir, "LICENSE"), join(targetDir, "LICENSE"), { dereference: true });
  }
  cpSync(binary, join(targetDir, "prebuilds", prebuildName(platform, arch)), { dereference: true });
  return { version: pkg.version, binary: prebuildName(platform, arch), targetDir };
}

function readWrapperSource(sourceDir) {
  const chunks = [];
  const stack = [join(sourceDir, "lib")];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(p);
      else if (entry.name.endsWith(".js")) chunks.push(readFileSync(p, "utf8"));
    }
  }
  return chunks.join("\n");
}

function isBuiltin(spec) {
  const bare = spec.startsWith("node:") ? spec.slice(5) : spec;
  return ["fs", "path", "util", "os", "crypto", "url", "module", "process"].includes(bare);
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try {
    const staged = stageSqlite();
    process.stdout.write(`stage:sqlite better-sqlite3@${staged.version} → ${staged.targetDir} (${staged.binary})\n`);
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  }
}
