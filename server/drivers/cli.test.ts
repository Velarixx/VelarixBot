// Cross-platform CLI execution contract. Windows npm/pnpm/yarn installs expose
// .cmd shims, while packaged Electron must invoke their real JS entry without
// routing model-controlled arguments through cmd.exe.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { _internal, cliExec, cliVersion, killProcessTree } from "./cli.ts";

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
  it("always hides the PowerShell launcher window", () => {
    expect(_internal.windowsSpawnOptions({ stdio: ["pipe", "pipe", "pipe"], detached: true })).toMatchObject({
      windowsHide: true,
    });
    expect(_internal.windowsSpawnOptions({ detached: true })).not.toHaveProperty("detached");
  });
});

describe("killProcessTree", () => {
  it("does not throw for absent processes", () => {
    expect(() => killProcessTree(undefined)).not.toThrow();
    expect(() => killProcessTree(999_999_999)).not.toThrow();
  });
});
