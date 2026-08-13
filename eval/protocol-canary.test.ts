import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { SECRET_NAMES } from "./secrets.mjs";
import {
  REQUIRED_FEATURE,
  REQUIRED_METHOD,
  advertisedMethodsFromInstall,
  driverGaps,
  skipMessage,
} from "./protocol-canary.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function runCanary(args: string[], extraEnv: Record<string, string> = {}) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [join(ROOT, "eval/protocol-canary.mjs"), ...args], {
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

describe("Codex protocol canary", () => {
  it("requires elicitation method + feature and -32601 in the live driver", () => {
    const source = readFileSync(join(ROOT, "server/drivers/codex.ts"), "utf8");
    expect(driverGaps(source)).toEqual([]);
    expect(source).toContain(REQUIRED_METHOD);
    expect(source).toContain(REQUIRED_FEATURE);
  });

  it("fails loudly when handleServerRequest does not implement elicitation", () => {
    const stub = `
      const handleServerRequest = (msg: any) => {
        send({ jsonrpc: "2.0", id: msg.id, result: { decision: "accept" } });
      };
    `;
    const gaps = driverGaps(stub);
    expect(gaps.some((g) => g.includes(REQUIRED_METHOD))).toBe(true);
    expect(gaps.some((g) => g.includes(REQUIRED_FEATURE))).toBe(true);
    expect(gaps.some((g) => g.includes("-32601"))).toBe(true);
  });

  it("finds advertised method strings in a fake install tree", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-canary-"));
    temps.push(dir);
    const bin = join(dir, "codex");
    writeFileSync(bin, `shim\n${REQUIRED_METHOD}\nexecCommandApproval\n`);
    expect(advertisedMethodsFromInstall(bin)).toEqual(expect.arrayContaining([REQUIRED_METHOD, "execCommandApproval"]));
  });

  it("exits 0 without secrets (full run and --gate)", async () => {
    const skip = await runCanary([]);
    expect(skip.code).toBe(0);
    expect(skip.stdout).toContain("Skipping Codex protocol canary");
    expect(skip.stdout).toContain(SECRET_NAMES.codex);
    expect(skip.stdout).not.toMatch(/sk-[A-Za-z0-9]|eyJ/);
    expect(skipMessage()).toContain(SECRET_NAMES.codex);

    const out = mkdtempSync(join(tmpdir(), "canary-gate-"));
    temps.push(out);
    const gate = await runCanary(["--gate"], { GITHUB_OUTPUT: join(out, "out.txt") });
    expect(gate.code).toBe(0);
    expect(readFileSync(join(out, "out.txt"), "utf8")).toContain("ran=false");
  });
});
