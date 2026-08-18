import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const picker = readFileSync(join(HERE, "ModelPicker.tsx"), "utf8");
const settings = readFileSync(join(HERE, "SettingsPanel.tsx"), "utf8");
const createModal = readFileSync(join(HERE, "CreateBotModal.tsx"), "utf8");

describe("per-bot effort picker", () => {
  it("lets Settings/ModelPicker set effort per bot, not workspace-global", () => {
    expect(picker).toContain("Reasoning effort");
    expect(picker).toContain("pickEffort");
    expect(picker).toContain("selection.effort");
    expect(settings).toContain("<ModelPicker bot={bot} />");
    expect(settings).toContain("Always allow");
    expect(settings).toMatch(/Let this bot do routine reads, writes, tool calls, and connected-app actions without\s+asking/);
  });

  it("dims snapshot.state !== available and still shows snapshot.reason — create reuses the same picker", () => {
    expect(picker).toContain('instance.snapshot.state !== "available"');
    expect(picker).toContain("unavailable && \"opacity-40\"");
    expect(picker).toContain("instance.snapshot.reason ?? \"unavailable\"");
    expect(picker).toContain("railInstance.snapshot.reason ?? \"unavailable\"");
    expect(createModal).toContain("<ModelPicker bot={preview}");
    expect(createModal).not.toMatch(/ModelCatalog|model catalog/i);
  });
});
