// Cross-platform CLI execution contract. Windows npm/pnpm/yarn installs expose
// .cmd shims, while packaged Electron must invoke their real JS entry without
// routing model-controlled arguments through cmd.exe.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { _internal, cliExec, cliVersion, killProcessTree, resolveCliCommand } from "./cli.ts";

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
});

describe("killProcessTree", () => {
  it("does not throw for absent processes", () => {
    expect(() => killProcessTree(undefined)).not.toThrow();
    expect(() => killProcessTree(999_999_999)).not.toThrow();
  });
});
