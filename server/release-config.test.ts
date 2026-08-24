import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

describe("internal desktop releases", () => {
  it("defines native unsigned packaging commands", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.scripts["package:mac"]).toContain("--mac");
    expect(pkg.scripts["package:mac"]).toContain("--arm64");
    expect(pkg.scripts["package:mac"]).toContain("fetch:cua");
    expect(pkg.scripts["package:win"]).toContain("--win");
    expect(pkg.scripts["package:win"]).toContain("fetch:cua");
    expect(pkg.scripts["package:win"]).toContain("stage:cua-sdk");
    expect(pkg.scripts["package:win"]).not.toContain("build:speech");
  });

  it("builds manual-trust DMG and NSIS installers", () => {
    const builder = read("electron-builder.yml");
    expect(builder).toContain('identity: "-"');
    expect(builder).toContain("target: nsis");
    expect(builder).toContain("VelarixBot-${version}-${arch}.dmg");
    const mac = builder.split("\nwin:")[0];
    expect(mac).toContain("- arm64");
    expect(mac).not.toMatch(/^\s+- x64\s*$/m);
    expect(builder).toContain("electron/resources/cua-driver");
    expect(builder).toContain("electron/resources/cua-driver.exe");
    expect(builder).toContain("build/generated-cua-sdk/node_modules/@trycua");
    const win = builder.slice(builder.indexOf("\nwin:"));
    expect(win).toContain("cua-driver.exe");
    expect(win).toContain("cua-sdk/node_modules/@trycua");
    expect(builder).toContain("sign: false");
  });

  it("publishes desktop assets from native GitHub runners", () => {
    const workflow = read(".github/workflows/release.yml");
    expect(workflow).toContain("macos-latest");
    expect(workflow).not.toContain("macos-15-intel");
    expect(workflow).toContain("--arm64");
    expect(workflow).toContain("windows-latest");
    expect(workflow).toContain("--prerelease");
    expect(workflow).toContain("SHA256SUMS.txt");
    expect(workflow).toContain("scripts/release-version.mjs");
    expect(workflow).toContain('CSC_IDENTITY_AUTO_DISCOVERY: "false"');
  });

  it("pre-creates the release tag at github.sha and does not pass --target", () => {
    const workflow = read(".github/workflows/release.yml");
    const release = workflow.slice(workflow.indexOf("  release:"));
    const commands = release
      .split("\n")
      .filter((line) => !/^\s*#/.test(line))
      .join("\n");
    expect(release).toContain("contents: write");
    expect(release).not.toMatch(/workflows:\s*write/);
    expect(commands).not.toMatch(/--target/);
    expect(release).toContain('gh api --method POST "repos/${{ github.repository }}/git/refs"');
    expect(release).toContain('ref="refs/tags/${tag}"');
    expect(release).toContain('sha="${sha}"');
    expect(release).toContain('tag="v${{ inputs.version }}"');
    expect(release).toContain('sha="${{ github.sha }}"');
    expect(release).toContain("gh release create");
    expect(release).toContain("GH_TOKEN: ${{ github.token }}");
  });

  it("checks GitHub Releases from the packaged updater without baking a token", () => {
    const updater = read("electron/updater.mjs");
    const feed = read("electron/update-feed.mjs");
    expect(feed).toContain('GITHUB_OWNER = "Velarixx"');
    expect(feed).toContain('GITHUB_REPO = "VelarixBot"');
    expect(updater).toContain("releasesUrl");
    expect(updater).not.toContain("ghp_");
    expect(feed).toContain("Set a GitHub token");
    expect(updater).toContain("SHA256SUMS");
    expect(updater).toContain("ELECTRON_RUN_AS_NODE");
    expect(updater).not.toContain("openPath");
    expect(updater).not.toMatch(/shell:\s*true/);
  });
});
