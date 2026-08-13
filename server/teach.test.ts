import { mkdirSync, rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import {
  deleteSkill,
  distillSkill,
  distillSkillMarkdown,
  getSkill,
  loadSkills,
  saveSkill,
  skillPrompt,
} from "./teach.ts";

describe("teach-a-task distill", () => {
  afterEach(() => rmSync(DATA_DIR, { recursive: true, force: true }));

  it("turns fake frames + events into ordered markdown steps", async () => {
    const markdown = await distillSkill({
      name: "File a report",
      frames: [{ at: 1 }, { at: 2 }, { at: 3 }],
      events: [
        { type: "item.started", itemType: "tool", title: "Open Chrome" },
        { type: "item.started", itemType: "tool", title: "Go to reports.example" },
        { type: "item.started", itemType: "tool", title: "Click New report" },
        { type: "item.completed", itemType: "assistant_text", text: "Filled the title field" },
        { type: "request.opened", tool: "sign-in" },
        { type: "item.started", itemType: "tool", title: "Submit" },
      ],
    });
    expect(markdown).toContain("# File a report");
    expect(markdown).toMatch(/1\. Open Chrome/);
    expect(markdown).toMatch(/2\. Go to reports\.example/);
    expect(markdown).toMatch(/3\. Click New report/);
    expect(markdown).toMatch(/4\. Filled the title field/);
    expect(markdown).toMatch(/5\. Wait for the user \(sign-in\)/);
    expect(markdown).toMatch(/6\. Submit/);
    expect(markdown).toContain("3 screen frames");
    expect(markdown).toMatch(/not replayed/);
    expect(markdown).not.toMatch(/pixel.?replay/i);
  });

  it("falls back to the deterministic draft when generateText fails", async () => {
    const markdown = await distillSkill({
      name: "Task",
      events: [{ type: "item.started", itemType: "tool", title: "Click Save" }],
      generateText: async () => {
        throw new Error("model down");
      },
    });
    expect(markdown).toContain("1. Click Save");
  });

  it("keeps duplicate consecutive tool titles as one step", () => {
    const markdown = distillSkillMarkdown({
      events: [
        { type: "item.started", itemType: "tool", title: "Click" },
        { type: "item.started", itemType: "tool", title: "Click" },
        { type: "item.started", itemType: "tool", title: "Type" },
      ],
    });
    expect(markdown).toMatch(/1\. Click\n2\. Type/);
  });

  it("saves a skill and attaches its markdown onto a routine prompt", () => {
    mkdirSync(DATA_DIR, { recursive: true });
    const skill = saveSkill({
      name: "File a report",
      botId: "bot-1",
      markdown: "# File a report\n\n1. Open Chrome\n2. Submit\n",
    });
    expect(getSkill(skill.id)?.name).toBe("File a report");
    expect(loadSkills()).toHaveLength(1);
    expect(skillPrompt(skill, "Do it now")).toContain("1. Open Chrome");
    expect(skillPrompt(skill, "Do it now")).toContain("Do it now");
    expect(deleteSkill(skill.id)).toBe(true);
    expect(getSkill(skill.id)).toBeNull();
  });
});
