/** Composer @mention helpers: bots stay ask_bot; routines fire startRun. */

export interface MentionQuery {
  start: number;
  query: string;
}

export interface MentionBot {
  id: string;
  name: string;
  hidden?: boolean;
}

export interface MentionRoutine {
  id: string;
  name: string;
  botId: string;
}

export type MentionCandidate =
  | { kind: "bot"; id: string; name: string }
  | { kind: "routine"; id: string; name: string; botId: string };

/** The active @mention query at the caret. null = no mention being typed. */
export function mentionQueryAt(text: string, caret: number): MentionQuery | null {
  const upto = text.slice(0, caret);
  const at = upto.lastIndexOf("@");
  if (at === -1) return null;
  if (at > 0 && !/\s/.test(upto[at - 1])) return null;
  const query = upto.slice(at + 1);
  if (query.length > 24 || query.includes("@") || query.includes("\n")) return null;
  return { start: at, query };
}

export function mentionableBots<T extends MentionBot>(bots: T[], selfId: string): T[] {
  return bots.filter((b) => b.id !== selfId && !b.hidden);
}

/** Routines whose bot still exists and is not hidden. */
export function mentionableRoutines<T extends MentionRoutine>(
  routines: T[],
  bots: Array<{ id: string; hidden?: boolean }>,
): T[] {
  const visible = new Set(bots.filter((b) => !b.hidden).map((b) => b.id));
  return routines.filter((r) => visible.has(r.botId));
}

export function filterMentionCandidates(
  query: string,
  bots: MentionBot[],
  routines: MentionRoutine[],
): MentionCandidate[] {
  const q = query.trim().toLowerCase();
  if (query.endsWith(" ")) {
    const exactBot = bots.some((b) => b.name.toLowerCase() === q);
    const exactRoutine = routines.some((r) => r.name.toLowerCase() === q);
    if (exactBot || exactRoutine) return [];
  }
  const botHits: MentionCandidate[] = bots
    .filter((b) => !q || b.name.toLowerCase().includes(q))
    .map((b) => ({ kind: "bot" as const, id: b.id, name: b.name }));
  const routineHits: MentionCandidate[] = routines
    .filter((r) => !q || r.name.toLowerCase().includes(q))
    .map((r) => ({ kind: "routine" as const, id: r.id, name: r.name, botId: r.botId }));
  return [...botHits, ...routineHits].slice(0, 8);
}

export function insertMention(text: string, caret: number, mention: MentionQuery, name: string): { text: string; caret: number } {
  const after = text.slice(caret);
  const next = `${text.slice(0, mention.start)}@${name} ${after}`;
  return { text: next, caret: mention.start + name.length + 2 };
}

/** Longest-name match at a word-start `@`, same rule as mentionedBots. */
function mentionedByName<T extends { name: string }>(text: string, items: T[]): T[] {
  const candidates = items.filter((p) => p.name.trim()).sort((a, b) => b.name.length - a.name.length);
  const lower = text.toLowerCase();
  const found: T[] = [];
  let at = -1;
  while ((at = lower.indexOf("@", at + 1)) !== -1) {
    if (at > 0 && !/\s/.test(text[at - 1])) continue;
    const hit = candidates.find((p) => lower.slice(at + 1).startsWith(p.name.toLowerCase()));
    if (hit && !found.includes(hit)) found.push(hit);
  }
  return found;
}

export function mentionedRoutines<T extends MentionRoutine>(text: string, routines: T[]): T[] {
  return mentionedByName(text, routines);
}

/** Strip `@Name` tokens for the given names (longest first). */
export function stripMentions(text: string, names: string[]): string {
  const ordered = [...names].filter((n) => n.trim()).sort((a, b) => b.length - a.length);
  let out = text;
  for (const name of ordered) {
    const re = new RegExp(`(^|\\s)@${escapeRegExp(name)}(?=\\s|$)`, "gi");
    out = out.replace(re, "$1");
  }
  return out.replace(/\s+/g, " ").trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface RoutineSend {
  routineId: string;
  /** Empty = mention-only → stored prompt. Otherwise this run's prompt. */
  prompt?: string;
}

/** Mention-only or mention+text → one startRun. @Bot-only stays a normal send. */
export function routineSendFromText(
  text: string,
  routines: MentionRoutine[],
  bots: MentionBot[],
): RoutineSend | null {
  const runnable = mentionableRoutines(routines, bots);
  const hits = mentionedRoutines(text, runnable);
  if (hits.length !== 1) return null;
  const extra = stripMentions(text, [hits[0].name]);
  return extra ? { routineId: hits[0].id, prompt: extra } : { routineId: hits[0].id };
}
