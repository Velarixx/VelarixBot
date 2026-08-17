// Teach service: stop is a draft distill (no skills.json row); confirm-save
// writes the SkillRecord and enables it add-not-replace. HOME is the vitest
// temp dir. No live box, no sleeps.
import { mkdirSync, rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "../config.ts";
import { EventBus } from "../harness/bus.ts";
import type { ProviderRegistry } from "../harness/registry.ts";
import { enabledSkillIds } from "../store.ts";
import {
  appendTeachEvent,
  appendTeachFrame,
  getRecordingSession,
  loadSkills,
  loadTeachSessions,
} from "../teach.ts";
import { createTeachService, type TeachBot } from "./teach.ts";

function fakeRegistry(
  instances: Array<{ instanceId: string; generateText?: (prompt: string) => Promise<string> }>,
): ProviderRegistry {
  return {
    instances: () => instances,
    get: (id: string) => instances.find((i) => i.instanceId === id) ?? null,
  } as unknown as ProviderRegistry;
}

describe("teach service stop / save / discard", () => {
  const bots = new Map<string, TeachBot>();
  let teach: ReturnType<typeof createTeachService>;

  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    mkdirSync(DATA_DIR, { recursive: true });
    bots.clear();
    bots.set("bot-1", {
      id: "bot-1",
      threadId: "thread-1",
      modelSelection: { instanceId: "codex" },
      enabledSkills: ["prior-a", "prior-b"],
    });
    teach = createTeachService({
      bus: new EventBus(),
      registry: fakeRegistry([
        { instanceId: "codex" },
        {
          instanceId: "claude",
          generateText: async () => "# File a report\n\n1. Open Chrome\n2. Submit\n",
        },
      ]),
      bot: (id) => bots.get(id) ?? null,
      patchBot: (id, patch) => {
        const bot = bots.get(id);
        if (!bot) return null;
        const next = { ...bot, ...patch };
        bots.set(id, next);
        return next;
      },
    });
  });

  afterEach(() => rmSync(DATA_DIR, { recursive: true, force: true }));

  it("turns fake events + frame timestamps into numbered markdown", async () => {
    teach.startTeachSession("bot-1");
    appendTeachEvent("bot-1", { type: "item.started", itemType: "tool", title: "Open Chrome" });
    appendTeachEvent("bot-1", { type: "item.started", itemType: "tool", title: "Submit" });
    appendTeachFrame("bot-1", { at: 1 });
    appendTeachFrame("bot-1", { at: 2 });
    const stop = await teach.stopTeachSession("bot-1", "File a report");
    expect(stop.markdown).toMatch(/1\. /);
    expect(stop.markdown).toMatch(/2\. /);
    expect(stop.session?.frames).toEqual([{ at: 1 }, { at: 2 }]);
    expect(JSON.stringify(stop.session?.frames)).not.toMatch(/png|pixel/i);
  });

  it("stop does not write a library skill; confirm-save does and keeps prior enables", async () => {
    teach.startTeachSession("bot-1");
    appendTeachEvent("bot-1", { type: "item.started", itemType: "tool", title: "Open Chrome" });
    const stop = await teach.stopTeachSession("bot-1", "File a report");
    expect(stop.recording).toBe(false);
    expect(stop.session?.status).toBe("completed");
    expect(stop.session?.skillId).toBeUndefined();
    expect(stop.session?.draftMarkdown).toBeTruthy();
    expect(loadSkills()).toHaveLength(0);
    expect(getRecordingSession("bot-1")).toBeNull();

    const saved = teach.saveTeachSession("bot-1", { name: "File a report", markdown: stop.markdown });
    expect(saved.skill.name).toBe("File a report");
    expect(saved.session?.skillId).toBe(saved.skill.id);
    expect(loadSkills()).toHaveLength(1);
    expect(enabledSkillIds(saved.bot)).toEqual(["prior-a", "prior-b", saved.skill.id]);
    expect(enabledSkillIds(bots.get("bot-1"))).toEqual(["prior-a", "prior-b", saved.skill.id]);
  });

  it("discard leaves no new skill and does not change enables", async () => {
    teach.startTeachSession("bot-1");
    appendTeachEvent("bot-1", { type: "item.started", itemType: "tool", title: "Click" });
    await teach.stopTeachSession("bot-1", "Scratch");
    expect(loadSkills()).toHaveLength(0);
    const discarded = teach.discardTeachSession("bot-1");
    expect(discarded.ok).toBe(true);
    expect(discarded.session?.skillId).toBeUndefined();
    expect(discarded.session?.draftMarkdown).toBeUndefined();
    expect(loadSkills()).toHaveLength(0);
    expect(enabledSkillIds(bots.get("bot-1"))).toEqual(["prior-a", "prior-b"]);
  });

  it("uses fleetGenerateText so a Codex bot still gets a rewrite", async () => {
    teach.startTeachSession("bot-1");
    appendTeachEvent("bot-1", { type: "item.started", itemType: "tool", title: "Open Chrome" });
    const stop = await teach.stopTeachSession("bot-1", "File a report");
    expect(stop.markdown).toContain("1. Open Chrome");
    expect(stop.markdown).toContain("2. Submit");
    expect(loadSkills()).toHaveLength(0);
  });

  it("falls back to distillSkillMarkdown when generateText fails and still completes stop", async () => {
    teach = createTeachService({
      bus: new EventBus(),
      registry: fakeRegistry([
        {
          instanceId: "codex",
          generateText: async () => {
            throw new Error("model down");
          },
        },
      ]),
      bot: (id) => bots.get(id) ?? null,
      patchBot: (id, patch) => {
        const bot = bots.get(id);
        if (!bot) return null;
        const next = { ...bot, ...patch };
        bots.set(id, next);
        return next;
      },
    });
    teach.startTeachSession("bot-1");
    appendTeachEvent("bot-1", { type: "item.started", itemType: "tool", title: "Click Save" });
    const stop = await teach.stopTeachSession("bot-1", "Task");
    expect(stop.markdown).toContain("1. Click Save");
    expect(stop.session?.status).toBe("completed");
    expect(loadSkills()).toHaveLength(0);
  });

  it("keeps the empty-events fallback and does not fail stop", async () => {
    teach = createTeachService({
      bus: new EventBus(),
      registry: fakeRegistry([{ instanceId: "codex" }]),
      bot: (id) => bots.get(id) ?? null,
      patchBot: (id, patch) => {
        const bot = bots.get(id);
        if (!bot) return null;
        const next = { ...bot, ...patch };
        bots.set(id, next);
        return next;
      },
    });
    teach.startTeachSession("bot-1");
    const stop = await teach.stopTeachSession("bot-1", "Empty session");
    expect(stop.markdown).toContain("Review the recorded session and describe the task in order.");
    expect(stop.session?.skillId).toBeUndefined();
    expect(loadSkills()).toHaveLength(0);
  });

  it("noteFrame increments timestamps on an idle recording without a turn", () => {
    teach.startTeachSession("bot-1");
    expect(getRecordingSession("bot-1")?.frames).toEqual([]);
    teach.noteFrame("bot-1");
    teach.noteFrame("bot-1");
    const session = getRecordingSession("bot-1");
    expect(session?.frames).toHaveLength(2);
    expect(session?.frames.every((f) => Object.keys(f).length === 1 && Number.isFinite(f.at))).toBe(true);
    expect(JSON.stringify(loadTeachSessions())).not.toMatch(/png|pixel/i);
  });
});
