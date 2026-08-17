import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  FULL_RELEASE_NOTES,
  RC_RELEASE_NOTES,
  formatGithubOutput,
  ghReleaseCreateExtras,
  parseReleaseVersion,
  releaseNotes,
} from "../scripts/release-version.mjs";

const root = join(import.meta.dirname, "..");
const helper = join(root, "scripts", "release-version.mjs");
const read = (path: string) => readFileSync(join(root, path), "utf8");

describe("release version gate", () => {
  let scratch = "";
  afterEach(() => {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
    scratch = "";
  });

  it("accepts 0.x.x as a full release and 0.x.x-rc.N as a prerelease", () => {
    expect(parseReleaseVersion("0.2.0")).toEqual({ version: "0.2.0", prerelease: false });
    expect(parseReleaseVersion("0.2.0-rc.1")).toEqual({ version: "0.2.0-rc.1", prerelease: true });
    expect(parseReleaseVersion(" 0.2.0-rc.18 ")).toEqual({ version: "0.2.0-rc.18", prerelease: true });
  });

  it("rejects 1.0.0, 0.2.0-beta, empty, and other junk", () => {
    for (const bad of ["1.0.0", "0.2.0-beta", "", "junk", "v0.2.0", "0.2.0-rc", "0.2.0-rc.", "2.0.0"]) {
      expect(() => parseReleaseVersion(bad), bad).toThrow(/Invalid 0\.x version/);
    }
  });

  it("keeps RC notes and does not call a full 0.x.x a release candidate", () => {
    const full = parseReleaseVersion("0.2.0");
    const rc = parseReleaseVersion("0.2.0-rc.1");
    expect(ghReleaseCreateExtras(full)).toEqual([]);
    expect(ghReleaseCreateExtras(rc)).toEqual(["--prerelease"]);
    expect(releaseNotes(full)).toBe(FULL_RELEASE_NOTES);
    expect(releaseNotes(rc)).toBe(RC_RELEASE_NOTES);
    expect(FULL_RELEASE_NOTES).toMatch(/unsigned desktop build/i);
    expect(FULL_RELEASE_NOTES).toContain("INTERNAL_INSTALL.md");
    expect(FULL_RELEASE_NOTES).not.toMatch(/release candidate/i);
    expect(RC_RELEASE_NOTES).toMatch(/release candidate/i);
    expect(RC_RELEASE_NOTES).toContain("INTERNAL_INSTALL.md");
  });

  it("writes GitHub Actions outputs without a shell", () => {
    scratch = mkdtempSync(join(tmpdir(), "omb-release-version-"));
    const out = join(scratch, "github-output");
    writeFileSync(out, "");
    const result = spawnSync(process.execPath, [helper, "--github-output", "0.2.0"], {
      encoding: "utf8",
      env: { ...process.env, GITHUB_OUTPUT: out },
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(readFileSync(out, "utf8")).toBe(formatGithubOutput(parseReleaseVersion("0.2.0")));

    const rejected = spawnSync(process.execPath, [helper, "1.0.0"], { encoding: "utf8" });
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toMatch(/Invalid 0\.x version/);
  });

  it("is the release.yml version gate and keeps artifacts on the input version", () => {
    const workflow = read(".github/workflows/release.yml");
    expect(workflow).toContain("node scripts/release-version.mjs --github-output");
    expect(workflow).not.toMatch(/Release candidate version/);
    expect(workflow).toMatch(/0\.x\.x/);
    expect(workflow).toContain("needs.validate.outputs.prerelease");
    expect(workflow).toContain("needs.validate.outputs.notes");
    expect(workflow).toMatch(/if \[ "\$RELEASE_PRERELEASE" = "true" \]; then/);
    expect(workflow).toContain('extra+=(--prerelease)');
    expect(workflow).toContain('pnpm version "${{ inputs.version }}" --no-git-tag-version');
    expect(workflow).toContain('v${{ inputs.version }}');
    expect(workflow).toContain("velarixbot-mac-arm64-${{ inputs.version }}");
    expect(workflow).toContain("velarixbot-windows-x64-${{ inputs.version }}");
    expect(workflow).toContain("VelarixBot-${{ inputs.version }}-arm64.dmg");
    expect(workflow).toContain("VelarixBot-Setup-${{ inputs.version }}-x64.exe");
    expect(workflow).toContain('CSC_IDENTITY_AUTO_DISCOVERY: "false"');
    expect(workflow).not.toMatch(/CSC_IDENTITY_AUTO_DISCOVERY:\s*"true"/);
    expect(workflow).not.toContain("^0\\.[0-9]+\\.[0-9]+-rc\\.[0-9]+$");
  });
});
