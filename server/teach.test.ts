import { mkdirSync, rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  appendTeachEvent,
  appendTeachFrame,
  completeTeachSession,
  confirmTeachSession,
  deleteSkill,
  deleteSkillsForBot,
  discardTeachDraft,
  distillSkill,
  distillSkillMarkdown,
  getRecordingSession,
  getSkill,
  getTeachDraftSession,
  listTeachSessions,
  loadSkills,
  loadTeachSessions,
  saveSkill,
  skillPrompt,
  skillSystemNote,
  skillsForTurn,
  startPersistedTeachSession,
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
    expect(skillSystemNote(skill)).toContain("1. Open Chrome");
    expect(skillSystemNote(null)).toBe("");
  });

  it("injects every enabled skill in stable order and keeps extras", () => {
    mkdirSync(DATA_DIR, { recursive: true });
    const a = saveSkill({ name: "A", botId: "bot-1", markdown: "# Skill A\n\n1. Alpha\n" });
    const b = saveSkill({ name: "B", botId: "bot-1", markdown: "# Skill B\n\n1. Bravo\n" });
    const c = saveSkill({ name: "C", botId: "bot-2", markdown: "# Skill C\n\n1. Charlie\n" });
    const note = skillSystemNote(skillsForTurn({ enabledSkills: [a.id, b.id] }, [c.id]));
    expect(note).toContain("Skill A");
    expect(note).toContain("Skill B");
    expect(note).toContain("Skill C");
    expect(note.indexOf("Skill A")).toBeLessThan(note.indexOf("Skill B"));
    expect(note.indexOf("Skill B")).toBeLessThan(note.indexOf("Skill C"));
    const afterDisable = skillSystemNote(skillsForTurn({ enabledSkills: [b.id] }, []));
    expect(afterDisable).toContain("Skill B");
    expect(afterDisable).not.toContain("Skill A");
  });

  it("keeps markdown when another bot still enables a deleted bot's skill", () => {
    mkdirSync(DATA_DIR, { recursive: true });
    const skill = saveSkill({ name: "Shared", botId: "bot-x", markdown: "# Shared\n\n1. Keep me\n" });
    deleteSkillsForBot("bot-x", [skill.id]);
    expect(getSkill(skill.id)?.markdown).toContain("Keep me");
    deleteSkillsForBot("bot-x", []);
    expect(getSkill(skill.id)).toBeNull();
  });

  it("persists an in-progress teach session and reloads it without a live box", () => {
    mkdirSync(DATA_DIR, { recursive: true });
    const started = startPersistedTeachSession("bot-1");
    expect(started.status).toBe("recording");
    appendTeachEvent("bot-1", { type: "item.started", itemType: "tool", title: "Open Chrome" });
    appendTeachFrame("bot-1", { at: 42 });
    const reloaded = loadTeachSessions();
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0].id).toBe(started.id);
    expect(reloaded[0].status).toBe("recording");
    expect(reloaded[0].events).toEqual([{ type: "item.started", itemType: "tool", title: "Open Chrome" }]);
    expect(reloaded[0].frames).toEqual([{ at: 42 }]);
    expect(getRecordingSession("bot-1")?.id).toBe(started.id);
    const skill = saveSkill({
      name: "File a report",
      botId: "bot-1",
      markdown: "# File a report\n\n1. Open Chrome\n",
    });
    const completed = completeTeachSession("bot-1", { name: "File a report", skillId: skill.id });
    expect(completed?.status).toBe("completed");
    expect(completed?.skillId).toBe(skill.id);
    expect(getRecordingSession("bot-1")).toBeNull();
    const listed = listTeachSessions("bot-1");
    expect(listed).toHaveLength(1);
    expect(listed[0].status).toBe("completed");
    expect(listed[0].name).toBe("File a report");
    expect(loadTeachSessions()[0].status).toBe("completed");
  });

  it("completes a session as a draft without writing a skill until confirm", () => {
    mkdirSync(DATA_DIR, { recursive: true });
    startPersistedTeachSession("bot-1");
    appendTeachEvent("bot-1", { type: "item.started", itemType: "tool", title: "Open Chrome" });
    const completed = completeTeachSession("bot-1", {
      name: "Draft skill",
      draftMarkdown: "# Draft skill\n\n1. Open Chrome\n",
    });
    expect(completed?.status).toBe("completed");
    expect(completed?.skillId).toBeUndefined();
    expect(completed?.draftMarkdown).toContain("1. Open Chrome");
    expect(loadSkills()).toHaveLength(0);
    expect(getTeachDraftSession("bot-1")?.id).toBe(completed?.id);

    const discarded = discardTeachDraft(completed!.id);
    expect(discarded?.skillId).toBeUndefined();
    expect(discarded?.draftMarkdown).toBeUndefined();
    expect(loadSkills()).toHaveLength(0);
  });

  it("confirm-save attaches skillId and drops the draft markdown", () => {
    mkdirSync(DATA_DIR, { recursive: true });
    startPersistedTeachSession("bot-1");
    const completed = completeTeachSession("bot-1", { name: "Keep", draftMarkdown: "1. Step\n" });
    const skill = saveSkill({ name: "Keep", botId: "bot-1", markdown: "1. Step\n" });
    const confirmed = confirmTeachSession(completed!.id, { skillId: skill.id, name: skill.name });
    expect(confirmed?.skillId).toBe(skill.id);
    expect(confirmed?.draftMarkdown).toBeUndefined();
    expect(getTeachDraftSession("bot-1")).toBeNull();
  });

  it("stores only { at } on frames even when extra keys are passed", () => {
    mkdirSync(DATA_DIR, { recursive: true });
    startPersistedTeachSession("bot-1");
    appendTeachFrame("bot-1", { at: 99, png: "iVBORw0KGgo", pixels: "nope" } as { at: number });
    const live = getRecordingSession("bot-1");
    expect(live?.frames).toEqual([{ at: 99 }]);
    expect(JSON.stringify(live?.frames)).not.toMatch(/png|pixel|iVBORw/i);

    writeFileSync(
      join(DATA_DIR, "teach-sessions.json"),
      JSON.stringify([
        {
          id: "s1",
          botId: "bot-2",
          status: "recording",
          events: [],
          frames: [{ at: 7, png: "abc" }],
          startedAt: 1,
        },
      ]),
    );
    const reloaded = loadTeachSessions();
    expect(reloaded[0].frames).toEqual([{ at: 7 }]);
    expect(JSON.stringify(reloaded)).not.toMatch(/png|abc/);
  });

  it("keeps the empty-events fallback string", () => {
    expect(distillSkillMarkdown({ name: "Empty", events: [] })).toContain(
      "Review the recorded session and describe the task in order.",
    );
  });
});
