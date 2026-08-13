// Emit/entry agreement: tsc must write dist-server/index.js, the file
// electron/main.mjs forks after extraResources copies dist-server → server.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  BUILT_ENTRY_REL,
  MAIN_FORK_RE,
  RESOURCES_SERVER_ENTRY_REL,
  assertBuiltServerEntry,
  assertPackagedMatchesBuilt,
  hashFile,
  packagedServerForkFromMain,
} from "../scripts/verify-packaged-server.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

describe("packaged server entry", () => {
  let scratch = "";
  afterEach(() => {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
    scratch = "";
  });

  it("pins tsc rootDir to server so emit stays a flat index.js", () => {
    const tsconfig = JSON.parse(read("tsconfig.server.build.json")) as {
      include?: string[];
      compilerOptions?: { rootDir?: string; outDir?: string };
    };
    expect(tsconfig.include).toEqual(["server"]);
    expect(tsconfig.compilerOptions?.rootDir).toBe("server");
    expect(tsconfig.compilerOptions?.outDir).toBe("dist-server");
    expect(read("tsconfig.server.json")).toContain("electron/update-feed.mjs");
    expect(JSON.parse(read("package.json")).scripts["build:server"]).toBe("node scripts/build-server.mjs");
  });

  it("agrees with main.mjs, electron-builder extraResources, and gitignore", () => {
    const main = read("electron/main.mjs");
    expect(packagedServerForkFromMain(main)).toBe(RESOURCES_SERVER_ENTRY_REL);
    expect(MAIN_FORK_RE.test(main)).toBe(true);
    const builder = read("electron-builder.yml");
    expect(builder).toMatch(/from:\s*dist-server/);
    expect(builder).toMatch(/to:\s*server/);
    expect(read(".gitignore").split(/\r?\n/)).toContain("dist-server");
    expect(read("CONTRIBUTING.md")).toMatch(/dist-server/);
  });

  it("fails a widened-rootDir tree that only has dist-server/server/index.js", () => {
    scratch = mkdtempSync(join(tmpdir(), "omb-packaged-server-"));
    mkdirSync(join(scratch, "server"), { recursive: true });
    writeFileSync(join(scratch, "server", "index.js"), "export {}\n");
    expect(() => assertBuiltServerEntry(scratch)).toThrow(/widened rootDir|packaged server entry missing/i);
  });

  it("accepts a flat just-built entry and rejects a different packaged copy", () => {
    scratch = mkdtempSync(join(tmpdir(), "omb-packaged-server-"));
    const entry = join(scratch, BUILT_ENTRY_REL);
    writeFileSync(entry, "export const marker = 'just-built';\n");
    const built = assertBuiltServerEntry(scratch);
    expect(built.hash).toBe(hashFile(entry));
    const packaged = join(scratch, "resources", "server", "index.js");
    mkdirSync(dirname(packaged), { recursive: true });
    writeFileSync(packaged, "export const marker = 'just-built';\n");
    expect(assertPackagedMatchesBuilt(packaged, built.hash)).toBe(built.hash);
    writeFileSync(packaged, "export const marker = 'stale-rc.3';\n");
    expect(() => assertPackagedMatchesBuilt(packaged, built.hash)).toThrow(/not the just-built server/);
    expect(() => assertPackagedMatchesBuilt(join(scratch, "missing.js"), built.hash)).toThrow(/packaged server missing/);
  });

  it("emits index.js (not server/index.js) when compiling with the build tsconfig", () => {
    scratch = mkdtempSync(join(tmpdir(), "omb-tsc-emit-"));
    const tsc = join(ROOT, "node_modules", "typescript", "bin", "tsc");
    const result = spawnSync(process.execPath, [tsc, "-p", "tsconfig.server.build.json", "--outDir", scratch, "--pretty", "false"], {
      cwd: ROOT,
      encoding: "utf8",
    });
    expect(result.status, result.stderr || result.stdout).toBe(0);
    const built = assertBuiltServerEntry(scratch);
    expect(built.entry).toBe(join(scratch, "index.js"));
    expect(readFileSync(built.entry, "utf8")).toMatch(/createServer|VelarixBot|OMB_PORT/);
  }, 30_000);

  it("gates the just-built server on both release runners", () => {
    const workflow = read(".github/workflows/release.yml");
    expect(workflow).toContain("verify-packaged-server.mjs");
    expect(workflow).toMatch(/mac-arm64\/VelarixBot\.app\/Contents\/Resources\/server\/index\.js/);
    expect(workflow).toMatch(/win-unpacked\/resources\/server\/index\.js/);
    expect(workflow).toContain("macos-latest");
    expect(workflow).not.toContain("macos-15-intel");
    const mac = workflow.slice(workflow.indexOf("  mac:"), workflow.indexOf("  windows:"));
    const win = workflow.slice(workflow.indexOf("  windows:"), workflow.indexOf("  release:"));
    expect(mac).toContain("verify-packaged-server.mjs");
    expect(win).toContain("verify-packaged-server.mjs");
    expect(mac).toContain("--arm64");
    expect(mac).not.toMatch(/--x64/);
  });

  it("leaves eval and portable as workflow_dispatch only", () => {
    for (const file of [".github/workflows/eval.yml", ".github/workflows/portable.yml"]) {
      const text = read(file);
      expect(text).toContain("workflow_dispatch");
      expect(text).not.toMatch(/^\s+schedule:/m);
      expect(text).not.toMatch(/^\s+pull_request:/m);
    }
    const ci = read(".github/workflows/ci.yml");
    expect(ci).toContain("ubuntu-latest");
    expect(ci).not.toMatch(/matrix:/);
  });
});
