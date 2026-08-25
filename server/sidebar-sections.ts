// First-class Conversations sections. Local JSON list { id, name } plus
// collapse keys — not derived from Title, not a project CRUD, not accounts.
// Membership lives on the bot as nullable sectionId.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { atomicWriteFileSync, ensurePrivateDir } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import { newId } from "./contracts.ts";

export interface SidebarSection {
  id: string;
  name: string;
}

const UNASSIGNED_LABEL = "Unassigned";

export const SIDEBAR_SECTIONS_FILE = "sidebar-sections.json";

export interface SidebarSectionsFile {
  sections: SidebarSection[];
  collapsed: string[];
}

function storePath(): string {
  return join(DATA_DIR, SIDEBAR_SECTIONS_FILE);
}

function isSection(value: unknown): value is SidebarSection {
  if (!value || typeof value !== "object") return false;
  const rec = value as { id?: unknown; name?: unknown };
  return typeof rec.id === "string" && rec.id.trim() !== "" && typeof rec.name === "string" && rec.name.trim() !== "";
}

function readStore(): SidebarSectionsFile {
  try {
    const raw = JSON.parse(readFileSync(storePath(), "utf8")) as Partial<SidebarSectionsFile>;
    const sections = Array.isArray(raw.sections) ? raw.sections.filter(isSection).map((s) => ({ id: s.id, name: s.name })) : [];
    const known = new Set(sections.map((s) => s.id));
    const collapsed = Array.isArray(raw.collapsed)
      ? raw.collapsed.filter((key): key is string => typeof key === "string" && (key === "" || known.has(key)))
      : [];
    return { sections, collapsed };
  } catch {
    return { sections: [], collapsed: [] };
  }
}

function writeStore(file: SidebarSectionsFile): void {
  ensurePrivateDir(DATA_DIR);
  atomicWriteFileSync(storePath(), JSON.stringify(file, null, 2));
}

export function listSidebarSections(): SidebarSection[] {
  return readStore().sections;
}

export function listCollapsedSectionKeys(): string[] {
  return readStore().collapsed;
}

export function readSidebarSections(): SidebarSectionsFile {
  return readStore();
}

export function getSidebarSection(id: string): SidebarSection | null {
  const key = id.trim();
  if (!key) return null;
  return readStore().sections.find((section) => section.id === key) ?? null;
}

export function normalizeSidebarSectionName(
  raw: unknown,
  existing: readonly SidebarSection[],
  opts?: { exceptId?: string },
): { ok: true; name: string } | { ok: false; error: string } {
  if (typeof raw !== "string") return { ok: false, error: "name must be a string" };
  const name = raw.trim();
  if (!name) return { ok: false, error: "name cannot be empty" };
  if (name.toLowerCase() === UNASSIGNED_LABEL.toLowerCase()) {
    return { ok: false, error: "Unassigned is not a user section" };
  }
  const taken = existing.some(
    (section) =>
      section.id !== opts?.exceptId && section.name.trim().toLowerCase() === name.toLowerCase(),
  );
  if (taken) return { ok: false, error: "section name already exists" };
  return { ok: true, name };
}

export function createSidebarSection(rawName: unknown): { ok: true; section: SidebarSection } | { ok: false; error: string; status: number } {
  const file = readStore();
  const name = normalizeSidebarSectionName(rawName, file.sections);
  if (!name.ok) return { ok: false, error: name.error, status: name.error.includes("already exists") ? 409 : 400 };
  const section: SidebarSection = { id: newId(), name: name.name };
  file.sections = [...file.sections, section];
  writeStore(file);
  return { ok: true, section };
}

export function renameSidebarSection(
  id: string,
  rawName: unknown,
): { ok: true; section: SidebarSection } | { ok: false; error: string; status: number } {
  const key = id.trim();
  if (!key) return { ok: false, error: "no such section", status: 404 };
  const file = readStore();
  const index = file.sections.findIndex((section) => section.id === key);
  if (index < 0) return { ok: false, error: "no such section", status: 404 };
  const name = normalizeSidebarSectionName(rawName, file.sections, { exceptId: key });
  if (!name.ok) return { ok: false, error: name.error, status: name.error.includes("already exists") ? 409 : 400 };
  const section = { id: key, name: name.name };
  file.sections = file.sections.map((row, i) => (i === index ? section : row));
  writeStore(file);
  return { ok: true, section };
}

export function deleteSidebarSection(id: string): { ok: true; section: SidebarSection } | { ok: false; error: string; status: number } {
  const key = id.trim();
  if (!key) return { ok: false, error: "no such section", status: 404 };
  const file = readStore();
  const section = file.sections.find((row) => row.id === key);
  if (!section) return { ok: false, error: "no such section", status: 404 };
  file.sections = file.sections.filter((row) => row.id !== key);
  file.collapsed = file.collapsed.filter((collapsed) => collapsed !== key);
  writeStore(file);
  return { ok: true, section };
}

export function writeCollapsedSectionKeys(keys: unknown): { ok: true; collapsed: string[] } | { ok: false; error: string; status: number } {
  if (!Array.isArray(keys) || keys.some((key) => typeof key !== "string")) {
    return { ok: false, error: "collapsed must be an array of strings", status: 400 };
  }
  const file = readStore();
  const known = new Set(file.sections.map((section) => section.id));
  file.collapsed = keys.filter((key) => key === "" || known.has(key));
  writeStore(file);
  return { ok: true, collapsed: file.collapsed };
}

export function sidebarSectionsFileMode(): number | null {
  if (!existsSync(storePath())) return null;
  return statSync(storePath()).mode & 0o777;
}
