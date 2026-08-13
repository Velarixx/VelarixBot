// Emit/entry agreement: tsc must write dist-server/index.js, the file
// electron/main.mjs forks after extraResources copies dist-server → server.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  CURRENT_CODE_MARKERS,
  SERVER_SMOKE_STAMP,
  assertCurrentPackagedCode,
  smokeEnv,
  smokePackagedServer,
} from "../scripts/smoke-packaged-server.mjs";
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

  it("emits index.js (not server/index.js) when compiling with the build tsconfig", async () => {
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
    expect(readFileSync(built.entry, "utf8")).toContain(SERVER_SMOKE_STAMP);
    const smoked = await smokePackagedServer(built.entry);
    expect(smoked.health).toMatchObject({ app: "velarixbot", stamp: SERVER_SMOKE_STAMP });
    expect(smoked.health).toEqual(expect.objectContaining({ pid: expect.any(Number) }));
  }, 60_000);

  it("gates the just-built server on both release runners", () => {
    const workflow = read(".github/workflows/release.yml");
    expect(workflow).toContain("verify-packaged-server.mjs");
    expect(workflow).toContain("smoke-packaged-server.mjs");
    expect(workflow).toMatch(/mac-arm64\/VelarixBot\.app\/Contents\/Resources\/server\/index\.js/);
    expect(workflow).toMatch(/win-unpacked\/resources\/server\/index\.js/);
    expect(workflow).toContain("macos-latest");
    expect(workflow).not.toContain("macos-15-intel");
    expect(workflow).not.toMatch(/^\s+pull_request:/m);
    expect(workflow).toContain("workflow_dispatch");
    const mac = workflow.slice(workflow.indexOf("  mac:"), workflow.indexOf("  windows:"));
    const win = workflow.slice(workflow.indexOf("  windows:"), workflow.indexOf("  release:"));
    expect(mac).toContain("verify-packaged-server.mjs");
    expect(win).toContain("verify-packaged-server.mjs");
    expect(mac).toContain("smoke-packaged-server.mjs");
    expect(win).toContain("smoke-packaged-server.mjs");
    expect(mac.indexOf("verify-packaged-server.mjs")).toBeLessThan(mac.indexOf("smoke-packaged-server.mjs"));
    expect(win.indexOf("verify-packaged-server.mjs")).toBeLessThan(win.indexOf("smoke-packaged-server.mjs"));
    expect(mac).toContain("--arm64");
    expect(mac).not.toMatch(/--x64/);
    expect(workflow).toMatch(/needs:\s*\[mac, windows\]/);
  });

  it("keeps eval/canary off pull_request and portable dispatch-only", () => {
    const evalYml = read(".github/workflows/eval.yml");
    expect(evalYml).toContain("workflow_dispatch");
    expect(evalYml).toMatch(/^\s+schedule:/m);
    expect(evalYml).toContain('cron: "0 6 * * 1-5"');
    expect(evalYml).not.toMatch(/^\s+pull_request:/m);
    expect(evalYml).toContain("ubuntu-latest");
    expect(evalYml).toContain("TIER_B_MAX_TURNS");
    expect(evalYml).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(evalYml).toContain("CODEX_AUTH_JSON");
    expect(evalYml).toContain("XAI_API_KEY");
    expect(evalYml).toContain("optional");
    expect(evalYml).not.toContain("smoke-packaged-server.mjs");

    const canary = read(".github/workflows/protocol-canary.yml");
    expect(canary).toContain("workflow_dispatch");
    expect(canary).toMatch(/^\s+schedule:/m);
    expect(canary).toContain('cron: "0 6 * * 1-5"');
    expect(canary).not.toMatch(/^\s+pull_request:/m);
    expect(canary).toContain("ubuntu-latest");
    expect(canary).toContain("CODEX_AUTH_JSON");
    expect(canary).toContain("mcpServer/elicitation/request");
    expect(canary).toContain("tool_call_mcp_elicitation");
    expect(canary).not.toContain("smoke-packaged-server.mjs");

    const portable = read(".github/workflows/portable.yml");
    expect(portable).toContain("workflow_dispatch");
    expect(portable).not.toMatch(/^\s+schedule:/m);
    expect(portable).not.toMatch(/^\s+pull_request:/m);
    expect(portable).not.toContain("smoke-packaged-server.mjs");

    const ci = read(".github/workflows/ci.yml");
    expect(ci).toContain("ubuntu-latest");
    expect(ci).not.toMatch(/matrix:/);
    expect(ci).not.toContain("macos-15-intel");
    expect(ci).not.toContain("smoke-packaged-server.mjs");
    expect(ci).not.toContain("electron-builder");
  });
});

describe("packaged server smoke", () => {
  let scratch = "";
  afterEach(() => {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
    scratch = "";
  });

  const fakeEntry = (source: string) => {
    scratch = mkdtempSync(join(tmpdir(), "omb-packaged-smoke-"));
    const entry = join(scratch, "index.js");
    writeFileSync(entry, source);
    return entry;
  };

  it("keeps health.stamp in lockstep with the smoke script", () => {
    expect(SERVER_SMOKE_STAMP).toBe(CURRENT_CODE_MARKERS.join("+"));
    expect(read("server/index.ts")).toContain(`stamp: "${SERVER_SMOKE_STAMP}"`);
    expect(read("server/drivers/codex.ts")).toContain("mcpOverlay");
    expect(read("server/index.ts")).toContain("ensureBotWorkspace");
  });

  it("does not pass Actions secrets into the smoked process", () => {
    const env = smokeEnv("/tmp/omb-smoke-home", 8799);
    expect(env).not.toHaveProperty("GITHUB_TOKEN");
    expect(env).not.toHaveProperty("GH_TOKEN");
    expect(env).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
    expect(env).not.toHaveProperty("CODEX_AUTH_JSON");
    expect(env.HOME).toBe("/tmp/omb-smoke-home");
    expect(env.USERPROFILE).toBe("/tmp/omb-smoke-home");
    expect(env.OMB_PORT).toBe("8799");
  });

  it("rejects a stale rc.3-shaped tree before boot", () => {
    const entry = fakeEntry(`export const marker = "stale-rc.3";\n`);
    expect(() => assertCurrentPackagedCode(entry)).toThrow(/stale|missing/i);
    expect(() => assertCurrentPackagedCode(join(scratch, "missing.js"))).toThrow(/packaged server missing/);
  });

  it("boots a current packaged-shaped entry to /api/health", async () => {
    const entry = fakeEntry(`
import { createServer } from "node:http";
const PORT = Number(process.env.OMB_PORT || 8799);
createServer((req, res) => {
  if (req.url === "/api/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      app: "velarixbot",
      pid: process.pid,
      static: false,
      stamp: "${SERVER_SMOKE_STAMP}",
    }));
    return;
  }
  res.statusCode = 404;
  res.end();
}).listen(PORT, "127.0.0.1");
`);
    const smoked = await smokePackagedServer(entry);
    expect(smoked.health).toMatchObject({ app: "velarixbot", stamp: SERVER_SMOKE_STAMP });
  });

  it("fails a server that listens with rc.3 health (no stamp)", async () => {
    const entry = fakeEntry(`
import { createServer } from "node:http";
const PORT = Number(process.env.OMB_PORT || 8799);
// ${CURRENT_CODE_MARKERS.join(" ")} ${SERVER_SMOKE_STAMP}
createServer((req, res) => {
  if (req.url === "/api/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ app: "velarixbot", pid: process.pid, static: false }));
    return;
  }
  res.statusCode = 404;
  res.end();
}).listen(PORT, "127.0.0.1");
`);
    await expect(smokePackagedServer(entry, { timeoutMs: 8_000 })).rejects.toThrow(/stamp|stale/i);
  });

  it("fails a current-looking file that never listens", async () => {
    const entry = fakeEntry(`
// ${CURRENT_CODE_MARKERS.join(" ")} ${SERVER_SMOKE_STAMP}
setInterval(() => {}, 60_000);
`);
    await expect(smokePackagedServer(entry, { timeoutMs: 800 })).rejects.toThrow(/never answered|exited/);
  });
});
