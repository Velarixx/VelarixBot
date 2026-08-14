// P0.6 CI gates: the secret scan must catch a planted token, never echo the
// value, and hold the tracked tree clean; ci.yml must actually run the scan
// and the dependency audit so a PR can't go green without them.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { collectTrackedFiles, isBinary, scanFiles, scanText } from "../scripts/secret-scan.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Canaries are built at runtime so no credential-shaped literal ever sits in
// the tree — a pasted literal here would (correctly) fail the tree scan below.
const fill = (n: number) => "aB9".repeat(n).slice(0, n);
const CANARIES: Array<[string, string]> = [
  ["github token", `ghp_${fill(36)}`],
  ["github fine-grained pat", `github_pat_${fill(22)}`],
  ["aws access key id", `AKIA${"ABCDEFGH23456789".slice(0, 16)}`],
  ["google api key", `AIza${fill(35)}`],
  ["slack token", ["xoxb", "1234567890", fill(12)].join("-")],
  ["stripe live key", ["sk", "live", fill(24)].join("_")],
  ["openai api key", `sk-proj-${fill(24)}`],
  ["anthropic api key", `sk-ant-${fill(24)}`],
  ["xai api key", `xai-${fill(32)}`],
  ["private key block", ["-----BEGIN", "OPENSSH", "PRIVATE", "KEY-----"].join(" ")],
];

describe("secret scan", () => {
  let scratch = "";
  afterEach(() => {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
    scratch = "";
  });

  it("flags every canary token shape with file, line, and pattern name only", () => {
    for (const [name, canary] of CANARIES) {
      const findings = scanText(`line one\nconst k = "${canary}";\n`, "fixture.ts");
      expect(findings, name).toEqual([{ path: "fixture.ts", line: 2, name }]);
      expect(JSON.stringify(findings), name).not.toContain(canary);
    }
  });

  it("ignores the short deliberately-fake secrets the existing tests use", () => {
    const text = 'token=sk-live-supersecret XAI_API_KEY=xai-abc123restofkey key sk-or-v1-secretvalue ghp-not-a-real-token';
    expect(scanText(text, "fixture.ts")).toEqual([]);
  });

  it("fails a tree with a planted canary and skips binary files", () => {
    scratch = mkdtempSync(join(tmpdir(), "omb-secret-scan-"));
    writeFileSync(join(scratch, "clean.ts"), "export const ok = true;\n");
    writeFileSync(join(scratch, "leaked.env"), `GITHUB_TOKEN=ghp_${fill(36)}\n`);
    writeFileSync(join(scratch, "blob.bin"), Buffer.concat([Buffer.from([0, 1, 2, 0]), Buffer.from(`ghp_${fill(36)}`)]));
    expect(isBinary(readFileSync(join(scratch, "blob.bin")))).toBe(true);
    const findings = scanFiles(["clean.ts", "leaked.env", "blob.bin", "missing.ts"], scratch);
    expect(findings).toEqual([{ path: "leaked.env", line: 1, name: "github token" }]);
  });

  it("holds the tracked tree clean (a committed dummy token fails this suite)", () => {
    const files = collectTrackedFiles(ROOT);
    expect(files.length).toBeGreaterThan(200);
    expect(scanFiles(files, ROOT)).toEqual([]);
  });
});

describe("ci wiring", () => {
  it("runs the secret scan and dependency audit inside the one required ci.yml job", () => {
    const ci = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
    expect(ci).toContain("node scripts/secret-scan.mjs");
    expect(ci).toContain("pnpm audit --audit-level=high");
    // both gates stay in the single required job — no second workflow, no matrix
    const jobs = ci.slice(ci.indexOf("jobs:"));
    expect(jobs.indexOf("secret-scan.mjs")).toBeGreaterThan(-1);
    expect(jobs.indexOf("pnpm audit")).toBeGreaterThan(-1);
    expect(ci.match(/runs-on:/g)).toHaveLength(1);
  });
});
