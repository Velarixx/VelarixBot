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
