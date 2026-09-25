import { useSyncExternalStore } from "react";
import type { AttachmentChip } from "./attachments";

export interface ComposerDraft {
  text: string;
  chips: AttachmentChip[];
  skills: Array<{ id: string; name: string }>;
}

const EMPTY: ComposerDraft = { text: "", chips: [], skills: [] };
const drafts = new Map<string, ComposerDraft>();
const listeners = new Map<string, Set<() => void>>();
const storageKey = (id: string) => `velarixbot:draft:v1:${id}`;

export function readDraft(id: string): ComposerDraft {
  if (!drafts.has(id)) {
    let draft = EMPTY;
    try {
      const saved = JSON.parse(sessionStorage.getItem(storageKey(id)) ?? "null");
      if (saved && typeof saved.text === "string" && Array.isArray(saved.chips) && Array.isArray(saved.skills)) {
        draft = {
          text: saved.text,
          chips: saved.chips.filter((c: AttachmentChip) => c && typeof c.path === "string" && typeof c.name === "string" && typeof c.id === "string"),
          skills: saved.skills.filter((s: { id: string; name: string }) => s && typeof s.id === "string" && typeof s.name === "string"),
        };
      }
    } catch { /* Keep drafts usable when browser storage is unavailable. */ }
    drafts.set(id, draft);
  }
  return drafts.get(id)!;
}

export function updateDraft(id: string, update: (current: ComposerDraft) => ComposerDraft): void {
  const next = update(readDraft(id));
  drafts.set(id, next);
  try {
    if (!next.text && !next.chips.length && !next.skills.length) sessionStorage.removeItem(storageKey(id));
    else sessionStorage.setItem(storageKey(id), JSON.stringify(next));
  } catch { /* A storage failure must never discard the in-memory draft. */ }
  listeners.get(id)?.forEach((listener) => listener());
}

export function useComposerDraft(id: string) {
  const draft = useSyncExternalStore(
    (listener) => {
      const set = listeners.get(id) ?? new Set();
      listeners.set(id, set);
      set.add(listener);
      return () => { set.delete(listener); };
    },
    () => readDraft(id),
    () => EMPTY,
  );
  const setField = <K extends keyof ComposerDraft>(key: K, value: ComposerDraft[K] | ((current: ComposerDraft[K]) => ComposerDraft[K])) => {
    updateDraft(id, (current) => ({ ...current, [key]: typeof value === "function" ? value(current[key]) : value }));
  };
  return {
    draft,
    setText: (value: string | ((current: string) => string)) => setField("text", value),
    setChips: (value: AttachmentChip[] | ((current: AttachmentChip[]) => AttachmentChip[])) => setField("chips", value),
    setSkills: (value: ComposerDraft["skills"] | ((current: ComposerDraft["skills"]) => ComposerDraft["skills"])) => setField("skills", value),
  };
}
