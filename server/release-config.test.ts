import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

describe("internal desktop releases", () => {
  it("defines native unsigned packaging commands", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.scripts["package:mac"]).toContain("--mac");
    expect(pkg.scripts["package:mac"]).toContain("fetch:cua");
    expect(pkg.scripts["package:win"]).toContain("--win");
    expect(pkg.scripts["package:win"]).not.toContain("build:speech");
  });

  it("builds manual-trust DMG and NSIS installers", () => {
    const builder = read("electron-builder.yml");
    expect(builder).toContain('identity: "-"');
    expect(builder).toContain("target: nsis");
    expect(builder).toContain("VelarixBot-${version}-${arch}.dmg");
    expect(builder).toContain("electron/resources/cua-driver");
    expect(builder).toContain("build/generated-cua-sdk/node_modules/@trycua");
    expect(builder).toContain("sign: false");
  });

  it("publishes RC assets from native GitHub runners", () => {
    const workflow = read(".github/workflows/release.yml");
    expect(workflow).toContain("macos-15-intel");
    expect(workflow).toContain("windows-latest");
    expect(workflow).toContain("--prerelease");
    expect(workflow).toContain("SHA256SUMS.txt");
  });

  it("keeps the updater dormant for private manual releases", () => {
    expect(read("electron/updater.mjs")).toContain("updates are installed manually from the private GitHub release");
  });
});
