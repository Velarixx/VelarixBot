import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "0.19.3";

/** Native + JS packages to stage for EmbeddedCuaDriverHost. Linux → []. */
export function cuaSdkPackages(platform = process.platform) {
  const common = [
    { scope: "@trycua", name: "cua-driver", globPrefix: `@trycua+cua-driver@${VERSION}` },
    { scope: "@ubjs", name: "core", globPrefix: "@ubjs+core@0.31.0-3" },
    { scope: "@ubjs", name: "node", globPrefix: "@ubjs+node@0.31.0-3" },
  ];
  if (platform === "darwin") {
    return [
      ...common,
      { scope: "@trycua", name: "cua-driver-darwin-arm64", globPrefix: `@trycua+cua-driver-darwin-arm64@${VERSION}` },
      { scope: "@trycua", name: "cua-driver-darwin-x64", globPrefix: `@trycua+cua-driver-darwin-x64@${VERSION}` },
    ];
  }
  if (platform === "win32") {
    return [
      ...common,
      { scope: "@trycua", name: "cua-driver-win32-x64-msvc", globPrefix: `@trycua+cua-driver-win32-x64-msvc@${VERSION}` },
      { scope: "@trycua", name: "cua-driver-win32-arm64-msvc", globPrefix: `@trycua+cua-driver-win32-arm64-msvc@${VERSION}`, optional: true },
    ];
  }
  return [];
}

export function stageCuaSdk({
  platform = process.platform,
  root = join(import.meta.dirname, ".."),
} = {}) {
  const packages = cuaSdkPackages(platform);
  if (packages.length === 0) return { skipped: true, reason: "unsupported-platform" };

  const pnpm = join(root, "node_modules", ".pnpm");
  const output = join(root, "build", "generated-cua-sdk", "node_modules");
  rmSync(output, { recursive: true, force: true });

  const staged = [];
  for (const item of packages) {
    const entry = readdirSync(pnpm).find((name) => name.startsWith(item.globPrefix));
    if (!entry) {
      if (item.optional) continue;
      throw new Error(`missing pnpm package ${item.globPrefix}; run pnpm install --frozen-lockfile`);
    }
    const source = join(pnpm, entry, "node_modules", item.scope, item.name);
    if (!existsSync(source)) {
      if (item.optional) continue;
      throw new Error(`missing staged source ${source}`);
    }
    const target = join(output, item.scope, item.name);
    mkdirSync(join(output, item.scope), { recursive: true });
    cpSync(source, target, { recursive: true, dereference: true });
    staged.push(`${item.scope}/${item.name}`);
  }
  return { skipped: false, staged, output };
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const result = stageCuaSdk();
  if (result.skipped) process.exit(0);
}
