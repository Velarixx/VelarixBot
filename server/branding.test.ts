import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

describe("VelarixBot branding", () => {
  it("uses the VelarixBot product and package identity", () => {
    expect(JSON.parse(read("package.json")).name).toBe("velarixbot");
    expect(read("index.html")).toContain("<title>VelarixBot</title>");
    expect(read("electron-builder.yml")).toContain("productName: VelarixBot");
    expect(read("electron-builder.yml")).toContain("appId: com.velarix.bot");
  });

  it("enforces Node >=24 in package.json and CI — do not claim untested 22 support", () => {
    // [VERIFY] 2026-08-18 M1: CI (.github/workflows/ci.yml) is Node 24 only.
    // README + CONTRIBUTING already say Node 24+. Some lockfile deps accept
    // 22, but we do not test 22 and must not advertise it.
    expect(JSON.parse(read("package.json")).engines.node).toBe(">=24");
    expect(read(".github/workflows/ci.yml")).toMatch(/node-version:\s*24/);
    expect(read("README.md")).toMatch(/Node 24\+/);
    expect(read("CONTRIBUTING.md")).toMatch(/Node 24\+/);
  });

  it("does not seed leftover product names in runtime", () => {
    const bots = read("server/services/bots.ts");
    expect(bots).toContain('name: "Chief of Staff"');
    expect(bots).not.toMatch(/name:\s*"Milind"/);
    expect(read("README.md")).not.toMatch(/SupaMaus/);
    expect(read("public/app-icon.svg")).not.toMatch(/SupaMaus/);
    expect(read("build/icon.svg")).not.toMatch(/SupaMaus/);
    expect(read("server/drivers/agents-proxy.ts")).toContain('name: "velarixbot-agents"');
    expect(read("server/drivers/agents-proxy.ts")).not.toContain("opengrokbot-agents");
  });

  it("keeps legacy data paths available for migration", () => {
    const config = read("server/config.ts");
    expect(config).toContain('".velarixbot"');
    expect(config).toContain('".openmausbot"');
    // the cua-connection.json candidate list lives with the local computer
    // provider (P1.1)
    const electron = read("server/computer/local.ts");
    expect(electron).toContain('"VelarixBot"');
    expect(electron).toContain('"OpenMausBot"');
    expect(read("server/box.ts")).toContain('"openmausbot-workspace"');
  });
});
