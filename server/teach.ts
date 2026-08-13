// Teach-a-task lite: record a supervised Box session (canonical events +
// frame counts, not pixels) and distill a reviewable ordered-step skill.
// Skills live in ~/.velarixbot/skills.json. No pixel replay.
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { DATA_DIR } from "./config.ts";
import { newId } from "./contracts.ts";

export interface SkillRecord {
  id: string;
  name: string;
  botId: string;
  markdown: string;
  createdAt: number;
}

export interface TeachEvent {
  type: string;
  itemType?: string;
  title?: string;
  text?: string;
  tool?: string;
  createdAt?: string;
}

export interface TeachFrame {
  at: number;
}

const SKILLS_FILE = join(DATA_DIR, "skills.json");

function atomicWrite(path: string, value: unknown) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}

function isSkill(v: unknown): v is SkillRecord {
  if (!v || typeof v !== "object") return false;
  const s = v as Partial<SkillRecord>;
  return (
    typeof s.id === "string" &&
    typeof s.name === "string" &&
    typeof s.botId === "string" &&
    typeof s.markdown === "string" &&
    Number.isFinite(s.createdAt)
  );
}

export function loadSkills(): SkillRecord[] {
  try {
    const raw: unknown = JSON.parse(readFileSync(SKILLS_FILE, "utf8"));
    if (!Array.isArray(raw)) return [];
    return raw.filter(isSkill);
  } catch {
    return [];
  }
}

function saveSkills(skills: SkillRecord[]) {
  atomicWrite(SKILLS_FILE, skills);
}

export function getSkill(id: string): SkillRecord | null {
  return loadSkills().find((s) => s.id === id) ?? null;
}

export function saveSkill(input: { name: string; botId: string; markdown: string; id?: string }): SkillRecord {
  const name = input.name.trim();
  const markdown = input.markdown.trim();
  if (!name || !markdown) throw new Error("name and markdown required");
  const skills = loadSkills();
  const existing = input.id ? skills.find((s) => s.id === input.id) : null;
  const skill: SkillRecord = {
    id: existing?.id ?? input.id ?? newId(),
    name,
    botId: input.botId,
    markdown,
    createdAt: existing?.createdAt ?? Date.now(),
  };
  saveSkills([...skills.filter((s) => s.id !== skill.id), skill]);
  return skill;
}

export function deleteSkill(id: string): boolean {
  const skills = loadSkills();
  if (!skills.some((s) => s.id === id)) return false;
  saveSkills(skills.filter((s) => s.id !== id));
  return true;
}

export function deleteSkillsForBot(botId: string): void {
  saveSkills(loadSkills().filter((s) => s.botId !== botId));
}

/** Deterministic step list from a recorded session. Frames are counted,
 * never replayed. Optional generateText can rewrite the draft; failure
 * falls back to the deterministic list. */
export function distillSkillMarkdown(opts: {
  name?: string;
  events: TeachEvent[];
  frames?: TeachFrame[];
}): string {
  const steps: string[] = [];
  for (const event of opts.events) {
    if (event.type === "item.started" && event.itemType === "tool") {
      const title = (event.title ?? event.tool ?? "tool").trim();
      if (title) steps.push(title);
    } else if (event.type === "item.completed" && event.itemType === "assistant_text" && event.text?.trim()) {
      steps.push(event.text.trim().slice(0, 200));
    } else if (event.type === "request.opened") {
      steps.push(`Wait for the user (${event.tool ?? "sign-in or approval"})`);
    }
  }
  const unique: string[] = [];
  for (const step of steps) {
    if (unique[unique.length - 1] === step) continue;
    unique.push(step);
  }
  const ordered = unique.length ? unique : ["Review the recorded session and describe the task in order."];
  const lines = [`# ${opts.name?.trim() || "Taught skill"}`, ""];
  if (opts.frames?.length) {
    lines.push(`_Recorded with ${opts.frames.length} screen frame${opts.frames.length === 1 ? "" : "s"} (not replayed)._`, "");
  }
  ordered.forEach((step, i) => lines.push(`${i + 1}. ${step}`));
  lines.push("");
  return lines.join("\n");
}

export async function distillSkill(opts: {
  name?: string;
  events: TeachEvent[];
  frames?: TeachFrame[];
  generateText?: (prompt: string) => Promise<string>;
}): Promise<string> {
  const draft = distillSkillMarkdown(opts);
  if (!opts.generateText) return draft;
  try {
    const out = (
      await opts.generateText(
        [
          "Turn this recorded computer-use session into a short numbered skill the user can edit and attach to a routine.",
          "Ordered steps only. No pixel coordinates, no secrets, no replay instructions.",
          draft,
        ].join("\n\n"),
      )
    ).trim();
    return out || draft;
  } catch {
    return draft;
  }
}

export function skillPrompt(skill: SkillRecord | null, routinePrompt: string): string {
  if (!skill?.markdown.trim()) return routinePrompt;
  return `${skill.markdown.trim()}\n\n${routinePrompt.trim()}`.trim();
}

export function deleteTeachScratch(botId: string): void {
  try {
    unlinkSync(join(DATA_DIR, `teach-${botId}.json`));
  } catch {
    /* missing is fine */
  }
}
