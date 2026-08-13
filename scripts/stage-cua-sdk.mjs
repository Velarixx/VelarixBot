import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

if (process.platform !== "darwin") process.exit(0);
const root = join(import.meta.dirname, "..");
const pnpm = join(root, "node_modules", ".pnpm");
const output = join(root, "build", "generated-cua-sdk", "node_modules");
rmSync(output, { recursive: true, force: true });

function copyPackage(scope, name, globPrefix) {
  const entry = readdirSync(pnpm).find((item) => item.startsWith(globPrefix));
  if (!entry) throw new Error(`missing pnpm package ${globPrefix}; run pnpm install --frozen-lockfile`);
  const source = join(pnpm, entry, "node_modules", scope, name);
  if (!existsSync(source)) throw new Error(`missing staged source ${source}`);
  const target = join(output, scope, name);
  mkdirSync(join(output, scope), { recursive: true });
  cpSync(source, target, { recursive: true, dereference: true });
}

copyPackage("@trycua", "cua-driver", "@trycua+cua-driver@0.19.3");
copyPackage("@trycua", "cua-driver-darwin-arm64", "@trycua+cua-driver-darwin-arm64@0.19.3");
copyPackage("@trycua", "cua-driver-darwin-x64", "@trycua+cua-driver-darwin-x64@0.19.3");
copyPackage("@ubjs", "core", "@ubjs+core@0.31.0-3");
copyPackage("@ubjs", "node", "@ubjs+node@0.31.0-3");
