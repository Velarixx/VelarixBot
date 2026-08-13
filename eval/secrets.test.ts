import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { detectSecrets, formatPresence, secretValues, skipMessage, SECRET_NAMES } from "./secrets.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function runEval(args: string[], extraEnv: Record<string, string> = {}) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [join(ROOT, "eval/run.mjs"), ...args], {
      cwd: ROOT,
      env: {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        ...extraEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("eval secret gate", () => {
  it("reports only booleans and never echoes values", () => {
    const env = {
      [SECRET_NAMES.claude]: "token-must-not-leak",
      [SECRET_NAMES.codex]: "",
      [SECRET_NAMES.grok]: "   ",
    };
    const found = detectSecrets(env);
    expect(found).toEqual({ claude: true, codex: false, grok: false, ready: true });
    expect(JSON.stringify(found)).not.toContain("token-must-not-leak");
    expect(formatPresence(found)).toContain("configured");
    expect(formatPresence(found)).not.toContain("token-must-not-leak");
    expect(secretValues(env)).toEqual(["token-must-not-leak"]);
  });

  it("treats an empty env as skip-clean", () => {
    expect(detectSecrets({})).toEqual({ claude: false, codex: false, grok: false, ready: false });
    expect(skipMessage()).toContain("Skipping Playwright eval");
    expect(skipMessage()).toContain(SECRET_NAMES.claude);
    expect(skipMessage()).toContain(SECRET_NAMES.codex);
    expect(skipMessage()).toContain("Grok / xAI is not required");
  });

  it("opens the gate for the existing Codex secret name", () => {
    const found = detectSecrets({ [SECRET_NAMES.codex]: "auth-json-must-not-leak" });
    expect(SECRET_NAMES.codex).toBe("CODEX_AUTH_JSON");
    expect(SECRET_NAMES.claude).toBe("CLAUDE_CODE_OAUTH_TOKEN");
    expect(found).toEqual({ claude: false, codex: true, grok: false, ready: true });
    expect(formatPresence(found)).not.toContain("auth-json-must-not-leak");
  });

  it("does not open the gate for a Grok-only env", () => {
    const found = detectSecrets({ [SECRET_NAMES.grok]: "xai-must-not-open-the-gate" });
    expect(found).toEqual({ claude: false, codex: false, grok: true, ready: false });
    expect(formatPresence(found)).toContain("optional");
  });

  it("exits 0 without secrets (full run and --gate)", async () => {
    const skip = await runEval([]);
    expect(skip.code).toBe(0);
    expect(skip.stdout).toContain("Skipping Playwright eval");
    expect(skip.stdout).not.toMatch(/sk-[A-Za-z0-9]|xai-|eyJ/);

    const out = mkdtempSync(join(tmpdir(), "eval-gate-"));
    temps.push(out);
    const gate = await runEval(["--gate"], { GITHUB_OUTPUT: join(out, "out.txt") });
    expect(gate.code).toBe(0);
    expect(readFileSync(join(out, "out.txt"), "utf8")).toContain("ran=false");
  });

  it("exits 0 when only an xAI secret is set (Grok never required)", async () => {
    const skip = await runEval([], { [SECRET_NAMES.grok]: "xai-must-not-open-the-gate" });
    expect(skip.code).toBe(0);
    expect(skip.stdout).toContain("Skipping Playwright eval");
    expect(skip.stdout).not.toContain("xai-must-not-open-the-gate");
  });
});
