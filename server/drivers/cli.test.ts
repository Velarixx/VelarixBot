// Cross-platform CLI execution contract. Windows npm/pnpm/yarn installs expose
// .cmd shims. npm Codex's shim target (bin/codex.js) is only a LAUNCHER for a
// vendored native codex.exe — the unwrap must bind stdio to that exe, never to
// the launcher under packaged (GUI-subsystem) Electron, and never route
// model-controlled arguments through cmd.exe.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { _internal, cliExec, cliVersion, killProcessTree, resolveCliCommand, spawnCliHidden } from "./cli.ts";

const PRINT_MARKER = "process.stdout.write(String(process.env.VELARIX_TEST_MARKER))";

describe("cliExec", () => {
  afterEach(() => {
    delete process.env.VELARIX_TEST_MARKER;
  });

  it("inherits the parent environment by default", async () => {
    process.env.VELARIX_TEST_MARKER = "inherited-ok";
    const result = await cliExec(process.execPath, ["-e", PRINT_MARKER]);
    expect(result.ok).toBe(true);
    expect(result.stdout).toBe("inherited-ok");
  });

  it("uses an explicit environment when one is supplied", async () => {
    process.env.VELARIX_TEST_MARKER = "wrong";
    const result = await cliExec(process.execPath, ["-e", PRINT_MARKER], {
      env: { VELARIX_TEST_MARKER: "explicit-wins", PATH: process.env.PATH ?? "" },
    });
    expect(result.ok).toBe(true);
    expect(result.stdout).toBe("explicit-wins");
  });

  it("reports a missing executable as a failed result", async () => {
    const result = await cliExec(join(tmpdir(), "velarix-definitely-missing"), ["--version"]);
    expect(result.ok).toBe(false);
  });
});

describe("cliVersion", () => {
  it("returns null for a missing CLI", async () => {
    expect(await cliVersion(join(tmpdir(), "velarix-definitely-missing"))).toBeNull();
  });

  it("returns trimmed output for an available CLI", async () => {
    expect(await cliVersion(process.execPath)).toBe(process.version);
  });

  it("uses the supplied environment for GUI PATH augmentation", async () => {
    expect(
      await cliVersion(process.execPath, 8000, {
        ...process.env,
        VELARIX_TEST_MARKER: "explicit-version-env",
      }),
    ).toBe(process.version);
  });
});

describe("Windows shim parsing", () => {
  let dir: string | undefined;
  const shim = (content: string) => {
    dir = mkdtempSync(join(tmpdir(), "velarix-shim-"));
    const target = join(dir, "codex.cmd");
    writeFileSync(target, content);
    return target;
  };

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("unwraps the current npm cmd-shim format", () => {
    const target = _internal.shimScriptTarget(
      shim('@SETLOCAL\r\n@SET "dp0=%~dp0"\r\n@"%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n'),
    );
    expect(target?.endsWith("codex.js")).toBe(true);
  });

  it("unwraps older yarn-style cmd shims", () => {
    const target = _internal.shimScriptTarget(
      shim('@IF EXIST "%~dp0\\node.exe" (\r\n  "%~dp0\\..\\pkg\\bin\\codex.js" %*\r\n)\r\n'),
    );
    expect(target?.endsWith("codex.js")).toBe(true);
  });

  it("rejects unknown environment-variable expansion", () => {
    expect(_internal.shimScriptTarget(shim('@"%MYSTERY_HOME%\\bin\\codex.js" %*\r\n'))).toBeNull();
  });
});

describe("npm launcher → native exe unwrap (rc.13 protocol_mismatch fix)", () => {
  // Models a real `npm i -g @openai/codex` global prefix:
  //   <prefix>/codex.cmd                                (npm cmd-shim)
  //   <prefix>/node_modules/@openai/codex/bin/codex.js  (launcher only)
  //   <prefix>/node_modules/@openai/codex-win32-<arch>/
  //       vendor/<triple>/bin/codex.exe                 (the real CLI)
  // bin/codex.js just spawns the native exe with stdio:"inherit" and mirrors
  // its exit code. Binding the driver's pipes to the launcher (via packaged
  // GUI-subsystem Electron under pwsh) is exactly the field failure — the
  // unwrap must resolve and bind the native exe itself.
  const TRIPLES: Record<string, string> = {
    x64: "x86_64-pc-windows-msvc",
    arm64: "aarch64-pc-windows-msvc",
  };
  const LAUNCHER_JS =
    "// launcher only: const child = spawn(binaryPath, process.argv.slice(2), { stdio: 'inherit' });\n" +
    "// process.exit(child.exitCode)\n";

  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  const makeNpmGlobalTree = (opts: { arch?: string; platformPkg?: boolean; fatVendor?: boolean } = {}) => {
    const arch = opts.arch ?? "x64";
    const triple = TRIPLES[arch];
    dir = mkdtempSync(join(tmpdir(), "velarix-npm-prefix-"));
    const pkgRoot = join(dir, "node_modules", "@openai", "codex");
    const script = join(pkgRoot, "bin", "codex.js");
    mkdirSync(dirname(script), { recursive: true });
    writeFileSync(join(pkgRoot, "package.json"), JSON.stringify({ name: "@openai/codex", version: "0.147.0" }));
    writeFileSync(script, LAUNCHER_JS);
    let nativeExe: string | null = null;
    if (opts.platformPkg !== false) {
      const platformRoot = join(dir, "node_modules", "@openai", `codex-win32-${arch}`);
      nativeExe = join(platformRoot, "vendor", triple, "bin", "codex.exe");
      mkdirSync(dirname(nativeExe), { recursive: true });
      writeFileSync(join(platformRoot, "package.json"), JSON.stringify({ name: `@openai/codex-win32-${arch}` }));
      writeFileSync(nativeExe, "MZ-fake-native-codex");
    }
    if (opts.fatVendor) {
      nativeExe = join(pkgRoot, "vendor", triple, "bin", "codex.exe");
      mkdirSync(dirname(nativeExe), { recursive: true });
      writeFileSync(nativeExe, "MZ-fake-native-codex");
    }
    // shimScriptTarget's %dp0% substitution is Windows-path-only, so model
    // the shim with the quoted absolute target it resolves to — the same
    // string the substitution yields on a real Windows prefix.
    const shim = join(dir, "codex.cmd");
    writeFileSync(shim, `@SETLOCAL\r\n@node "${script}" %*\r\n`);
    return { shim, script, nativeExe };
  };

  it("resolves the vendored native exe from the launcher script (platform package)", () => {
    const { script, nativeExe } = makeNpmGlobalTree({ arch: "x64" });
    expect(_internal.nativeLauncherExe(script, "x64")).toBe(nativeExe);
    expect(nativeExe).toContain(join("codex-win32-x64", "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe"));
  });

  it("resolves the arm64 triple for win32-arm64 installs", () => {
    const { script, nativeExe } = makeNpmGlobalTree({ arch: "arm64" });
    expect(_internal.nativeLauncherExe(script, "arm64")).toBe(nativeExe);
    expect(nativeExe).toContain("aarch64-pc-windows-msvc");
  });

  it("falls back to the fat package's own vendor dir when the platform package is absent", () => {
    const { script, nativeExe } = makeNpmGlobalTree({ platformPkg: false, fatVendor: true });
    expect(_internal.nativeLauncherExe(script, "x64")).toBe(nativeExe);
    expect(nativeExe).toContain(join("@openai", "codex", "vendor"));
  });

  it("returns null when no vendored exe exists — plain JS CLIs keep the node path", () => {
    const { script } = makeNpmGlobalTree({ platformPkg: false });
    expect(_internal.nativeLauncherExe(script, "x64")).toBeNull();
  });

  it("returns null for a script outside any package", () => {
    dir = mkdtempSync(join(tmpdir(), "velarix-bare-"));
    const script = join(dir, "bin", "codex.js");
    mkdirSync(dirname(script), { recursive: true });
    writeFileSync(script, LAUNCHER_JS);
    expect(_internal.nativeLauncherExe(script, "x64")).toBeNull();
  });

  it("unwraps shim → launcher → NATIVE exe: turn stdio binds to codex.exe, not Electron-as-node", () => {
    const { shim, nativeExe } = makeNpmGlobalTree({ arch: "x64" });
    const unwrapped = _internal.windowsShimCommand(shim, "x64")!;
    // the command spawnCliHidden/execFile will bind pipes to IS the native
    // exe — no process.execPath (packaged: GUI-subsystem VelarixBot.exe)
    // launcher hop that pwsh fire-and-forgets, no ELECTRON_RUN_AS_NODE
    expect(unwrapped.command).toBe(nativeExe);
    expect(unwrapped.command).not.toBe(process.execPath);
    expect(unwrapped.args).toEqual([]);
    expect(unwrapped.env).toBeUndefined();
    // a native .exe target never trips the .cmd metacharacter refusal and
    // never needs cmd.exe
    expect(unwrapped.command).toMatch(/\.exe$/i);
  });

  it("keeps the node + JS-entry fallback for unwrapped shims without a vendored exe", () => {
    const { shim, script } = makeNpmGlobalTree({ platformPkg: false });
    const unwrapped = _internal.windowsShimCommand(shim, "x64")!;
    expect(unwrapped.command).toBe(process.execPath);
    expect(unwrapped.args).toEqual([script]);
    expect(unwrapped.env).toMatchObject({ ELECTRON_RUN_AS_NODE: "1" });
  });

  it("still refuses to unwrap a shim with unknown var expansion (no cmd.exe fallback)", () => {
    dir = mkdtempSync(join(tmpdir(), "velarix-optout-"));
    const shim = join(dir, "codex.cmd");
    writeFileSync(shim, '@"%MYSTERY_HOME%\\bin\\codex.js" %*\r\n');
    expect(_internal.windowsShimCommand(shim, "x64")).toBeNull();
  });

  it("wraps the native exe in the hidden CLI tree like claude.exe (hide-console rules intact)", () => {
    const { shim } = makeNpmGlobalTree({ arch: "x64" });
    const unwrapped = _internal.windowsShimCommand(shim, "x64")!;
    // console-subsystem exe under the pwsh -WindowStyle Hidden wrapper;
    // args travel via JSON file — never a shell command string
    expect(_internal.shouldWrapCliTree("codex")).toBe(true);
    const { args, cleanup } = _internal.pwshWrapperArgs(unwrapped.command, ["app-server"]);
    try {
      expect(args[args.indexOf("-Cli") + 1]).toBe(unwrapped.command);
      expect(args.join(" ")).not.toMatch(/cmd\.exe|shell:true/i);
    } finally {
      cleanup();
    }
  });
});

describe("Windows hidden process contract", () => {
  it("hides short-lived harness helpers with windowsHide / CREATE_NO_WINDOW", () => {
    expect(_internal.windowsSpawnOptions({ stdio: ["pipe", "pipe", "pipe"], detached: true })).toMatchObject({
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    expect(_internal.windowsSpawnOptions({ detached: true })).not.toHaveProperty("detached");
    expect(_internal.windowsSpawnOptions({ windowsHide: false, detached: true })).toMatchObject({ windowsHide: true });
  });

  it("does not CREATE_NO_WINDOW the CLI tree root so grandchildren inherit a hidden console", () => {
    const tree = _internal.windowsCliTreeSpawnOptions({
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
      windowsHide: true,
    });
    expect(tree).toMatchObject({ windowsHide: false, stdio: ["pipe", "pipe", "pipe"] });
    expect(tree).not.toHaveProperty("detached");
  });

  it("hides the pwsh wrapper via argv, not a shell command string", () => {
    const { args, cleanup } = _internal.pwshWrapperArgs("C:\\\\codex.exe", ["app-server", "--model", "gpt-5.6-sol"]);
    try {
      expect(args).toEqual(
        expect.arrayContaining(["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-File", "-Cli", "-ArgsFile"]),
      );
      expect(args.join(" ")).not.toMatch(/cmd\.exe|shell:true/i);
      const fileIdx = args.indexOf("-File");
      const argsIdx = args.indexOf("-ArgsFile");
      expect(args[fileIdx + 1]).toMatch(/wrap\.ps1$/);
      expect(args[argsIdx + 1]).toMatch(/args\.json$/);
    } finally {
      cleanup();
    }
  });

  it("wraps packaged Codex/node JS entries in the hidden CLI tree, not CREATE_NO_WINDOW", () => {
    expect(_internal.shouldWrapCliTree("codex")).toBe(true);
    expect(_internal.shouldWrapCliTree("claude")).toBe(true);
    expect(_internal.shouldWrapCliTree("C:\\\\Program Files\\\\codex.exe")).toBe(true);
    expect(_internal.isTestScriptCli(join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-acp-cli.ts"))).toBe(
      true,
    );
    expect(_internal.shouldWrapCliTree(join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-acp-cli.ts"))).toBe(
      false,
    );
    expect(_internal.windowsCliTreeSpawnOptions({ windowsHide: true }).windowsHide).toBe(false);
    expect(_internal.windowsSpawnOptions({}).windowsHide).toBe(true);
    expect(_internal.argsSafeForWindowsPowerShell(["app-server"])).toBe(true);
    expect(_internal.argsSafeForWindowsPowerShell(['--mcp-config', '{"mcpServers":{}}'])).toBe(false);
    expect(_internal.windowsPowerShellPath()).toMatch(/WindowsPowerShell/i);
    expect(_internal.windowsPowerShellPath()).not.toMatch(/cmd\.exe/i);
  });
});

describe("script CLI resolution (Windows-safe fakes)", () => {
  const testing = join(dirname(fileURLToPath(import.meta.url)), "..", "testing");

  it("runs a .ts fake under process.execPath so Windows can spawn it", async () => {
    const fake = join(testing, "fake-acp-cli.ts");
    const resolved = resolveCliCommand(fake);
    expect(resolved.command).toBe(process.execPath);
    expect(resolved.args).toEqual([fake]);
    expect(resolved.env).toMatchObject({ ELECTRON_RUN_AS_NODE: "1" });
    expect(await cliVersion(fake)).toMatch(/fake-acp/);
  });

  it("answers fake-claude --version and one-shot text generate", async () => {
    const fake = join(testing, "fake-claude-cli.ts");
    expect(await cliVersion(fake)).toMatch(/fake-claude/);
    const result = await cliExec(fake, ["-p", "distill this", "--model", "claude-haiku-4-5", "--output-format", "text"]);
    expect(result.ok).toBe(true);
    expect(result.stdout).toMatch(/concise replies/i);
  });

  it("answers fake-codex --version", async () => {
    expect(await cliVersion(join(testing, "fake-codex-app-server.ts"))).toMatch(/fake-codex/);
  });

  it("does not rewrite a bare CLI name into a node script spawn", () => {
    const resolved = resolveCliCommand("claude");
    expect(resolved.args).toEqual([]);
    expect(resolved.command).not.toBe(process.execPath);
  });

  it("spawns a .ts fake under node directly — not wrap.ps1", async () => {
    const fake = join(testing, "fake-acp-cli.ts");
    expect(_internal.spawnDirectNode(process.execPath)).toBe(true);
    expect(_internal.spawnDirectNode("C:\\Program Files\\PowerShell\\7\\pwsh.exe")).toBe(false);
    const child = spawnCliHidden(fake, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    const code = await new Promise<number | null>((resolvePromise) => child.on("close", resolvePromise));
    expect(code).toBe(0);
    expect(out).toMatch(/fake-acp/);
    expect(child.spawnfile).toBe(process.execPath);
    expect(child.spawnargs.join(" ")).toContain("fake-acp-cli.ts");
    expect(child.spawnargs.join(" ")).not.toMatch(/wrap\.ps1|pwsh/i);
  });
});

describe("killProcessTree", () => {
  it("does not throw for absent processes", () => {
    expect(() => killProcessTree(undefined)).not.toThrow();
    expect(() => killProcessTree(999_999_999)).not.toThrow();
  });
});
