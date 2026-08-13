// Teach-a-task lite: record a supervised Box session (canonical events +
// frame counts, not pixels) and distill a reviewable ordered-step skill.
// Skills live in ~/.velarixbot/skills.json. Teach sessions live in
// ~/.velarixbot/teach-sessions.json so a harness restart can list and
// resume them. No pixel replay.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

export type TeachStatus = "recording" | "completed";

export interface TeachSessionRecord {
  id: string;
  botId: string;
  status: TeachStatus;
  events: TeachEvent[];
  frames: TeachFrame[];
  startedAt: number;
  stoppedAt?: number;
  name?: string;
  skillId?: string;
}

const SKILLS_FILE = join(DATA_DIR, "skills.json");
const SESSIONS_FILE = join(DATA_DIR, "teach-sessions.json");

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

function isTeachEvent(v: unknown): v is TeachEvent {
  if (!v || typeof v !== "object") return false;
  const e = v as Partial<TeachEvent>;
  return typeof e.type === "string";
}

function isTeachFrame(v: unknown): v is TeachFrame {
  if (!v || typeof v !== "object") return false;
  return Number.isFinite((v as Partial<TeachFrame>).at);
}

function isTeachSession(v: unknown): v is TeachSessionRecord {
  if (!v || typeof v !== "object") return false;
  const s = v as Partial<TeachSessionRecord>;
  if (typeof s.id !== "string" || typeof s.botId !== "string") return false;
  if (s.status !== "recording" && s.status !== "completed") return false;
  if (!Number.isFinite(s.startedAt)) return false;
  if (!Array.isArray(s.events) || !Array.isArray(s.frames)) return false;
  return s.events.every(isTeachEvent) && s.frames.every(isTeachFrame);
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
  saveTeachSessions(loadTeachSessions().filter((s) => s.botId !== botId));
}

export function loadTeachSessions(): TeachSessionRecord[] {
  try {
    const raw: unknown = JSON.parse(readFileSync(SESSIONS_FILE, "utf8"));
    if (!Array.isArray(raw)) return [];
    return raw.filter(isTeachSession);
  } catch {
    return [];
  }
}

function saveTeachSessions(sessions: TeachSessionRecord[]) {
  atomicWrite(SESSIONS_FILE, sessions);
}

export function listTeachSessions(botId?: string): TeachSessionRecord[] {
  const all = loadTeachSessions();
  const filtered = botId ? all.filter((s) => s.botId === botId) : all;
  return filtered.sort((a, b) => b.startedAt - a.startedAt);
}

export function getTeachSession(id: string): TeachSessionRecord | null {
  return loadTeachSessions().find((s) => s.id === id) ?? null;
}

export function getRecordingSession(botId: string): TeachSessionRecord | null {
  return loadTeachSessions().find((s) => s.botId === botId && s.status === "recording") ?? null;
}

export function startPersistedTeachSession(botId: string): TeachSessionRecord {
  const sessions = loadTeachSessions().filter((s) => !(s.botId === botId && s.status === "recording"));
  const session: TeachSessionRecord = {
    id: newId(),
    botId,
    status: "recording",
    events: [],
    frames: [],
    startedAt: Date.now(),
  };
  saveTeachSessions([...sessions, session]);
  return session;
}

function patchSession(botId: string, fn: (session: TeachSessionRecord) => TeachSessionRecord): TeachSessionRecord | null {
  const sessions = loadTeachSessions();
  const index = sessions.findIndex((s) => s.botId === botId && s.status === "recording");
  if (index < 0) return null;
  const next = fn(sessions[index]);
  sessions[index] = next;
  saveTeachSessions(sessions);
  return next;
}

export function appendTeachEvent(botId: string, event: TeachEvent): TeachSessionRecord | null {
  return patchSession(botId, (session) => ({ ...session, events: [...session.events, event] }));
}

export function appendTeachFrame(botId: string, frame: TeachFrame = { at: Date.now() }): TeachSessionRecord | null {
  return patchSession(botId, (session) => ({ ...session, frames: [...session.frames, frame] }));
}

export function completeTeachSession(
  botId: string,
  opts: { name?: string; skillId: string },
): TeachSessionRecord | null {
  return patchSession(botId, (session) => ({
    ...session,
    status: "completed",
    stoppedAt: Date.now(),
    name: opts.name?.trim() || session.name,
    skillId: opts.skillId,
  }));
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
          "Turn this recorded computer-use session into a short numbered skill the user can edit and attach to a bot or a routine.",
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

export function skillSystemNote(skill: SkillRecord | null): string {
  if (!skill?.markdown.trim()) return "";
  return `\n\nFollow this attached skill:\n${skill.markdown.trim()}`;
}
