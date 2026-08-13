import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("Require approval locator", () => {
  it("uses a unique switch name that matches the settings aria-label", () => {
    const flow = readFileSync(join(ROOT, "eval/flow.mjs"), "utf8");
    const panel = readFileSync(join(ROOT, "src/components/SettingsPanel.tsx"), "utf8");
    expect(flow).toContain('export const REQUIRE_APPROVAL_SWITCH = "Require approval"');
    expect(flow).toContain('getByRole("switch", { name: REQUIRE_APPROVAL_SWITCH, exact: true })');
    expect(flow).not.toContain('locator("div.flex")');
    expect(flow).not.toMatch(/hasText:\s*["']Require approval["']/);
    expect(panel).toContain('aria-label="Require approval"');
    expect(panel).toContain('role="switch"');
  });
});
