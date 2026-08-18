// PRO: post-turn extract becomes suggestion cards. Cards only — never
// auto-run a turn, write memory, or create a routine until the user
// accepts. Dismiss persists the card state and nothing else (not an
// Allow-always rule). Workflow accept reuses createRoutine; fact and
// preference accept reuse insertMemoryRow. No second scheduler.
//
// 2026-08-18 [VERIFY]: extract is still suggestions only. A workflow
// row that has been injected enough times (useCount after bump ≥
// WORKFLOW_ROUTINE_PROMPT_USE_COUNT) also emits this same
// requestType: "suggestion" card via suggestionCardsFor. Accept still
// goes through isSuggestionAccept / acceptSuggestion / PATCH
// /api/bots/:id/cards/:messageId. Never startTurn / runRoutines.
import { insertMemoryRow, type MemoryRow, type MemoryRowType } from "./memory.ts";
import type { CreateRoutineInput } from "./services/routines.ts";
import type { OptionCardData, RoutineRecord } from "./store.ts";

export const SUGGESTION_REQUEST_TYPE = "suggestion" as const;
export const SUGGESTION_ACCEPT_WORKFLOW = "Save as routine";
export const SUGGESTION_ACCEPT_MEMORY = "Remember";
export const DEFAULT_WORKFLOW_SCHEDULE = { kind: "weekdays" as const, time: "09:00" };

/** A type==="workflow" row earns a "Save as a routine?" card once
 * useCount (after inject bump) reaches this threshold. One-shot LLM
 * extract remains allowed; it is not a substitute for this path.
 * 2026-08-18: pinned at 3. Never auto-runs the routine. */
export const WORKFLOW_ROUTINE_PROMPT_USE_COUNT = 3;

export type SuggestionKind = MemoryRowType;

export interface SuggestionPayload {
  botId: string;
  type: SuggestionKind;
  text: string;
}

export function isSuggestionCard(card?: Pick<OptionCardData, "requestType"> | null): boolean {
  return card?.requestType === SUGGESTION_REQUEST_TYPE;
}

/** A/B/C next-step chips and onboarding still start a turn. Suggestion
 * cards never do — accept/dismiss stay on the card APIs. */
export function cardAnswerStartsTurn(card?: Pick<OptionCardData, "requestId" | "requestType"> | null): boolean {
  if (!card) return false;
  if (card.requestId) return false;
  if (isSuggestionCard(card)) return false;
  return true;
}

function normalizeNote(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

export function suggestionAcceptLabel(type: SuggestionKind): string {
  return type === "workflow" ? SUGGESTION_ACCEPT_WORKFLOW : SUGGESTION_ACCEPT_MEMORY;
}

export function suggestionCard(item: SuggestionPayload): OptionCardData {
  const text = item.text.trim();
  const workflow = item.type === "workflow";
  return {
    title: workflow ? "Save as a routine?" : item.type === "preference" ? "Remember this preference?" : "Remember this?",
    subtitle: text,
    options: [suggestionAcceptLabel(item.type)],
    requestType: SUGGESTION_REQUEST_TYPE,
    suggestion: { botId: item.botId, type: item.type, text },
  };
}

export function isSuggestionAccept(card: OptionCardData, answer: string): boolean {
  if (!isSuggestionCard(card) || !card.suggestion) return false;
  return answer.trim() === suggestionAcceptLabel(card.suggestion.type);
}

/** Workflow rows this bot has already injected enough times. Other
 * botIds never appear. Caller feeds these into suggestionCardsFor
 * (omit existingRows — the row is the source, not a duplicate note). */
export function suggestionItemsFromRepeatedWorkflows(
  botId: string,
  rows: Array<{ botId: string; type: string; text: string; useCount: number }>,
): Array<{ type: "workflow"; text: string }> {
  const out: Array<{ type: "workflow"; text: string }> = [];
  for (const row of rows) {
    if (row.botId !== botId) continue;
    if (row.type !== "workflow") continue;
    if (row.useCount < WORKFLOW_ROUTINE_PROMPT_USE_COUNT) continue;
    const text = row.text.trim();
    if (!text) continue;
    out.push({ type: "workflow", text });
  }
  return out;
}

/** Drop notes this bot already has, and suggestion cards already on the
 * thread (pending, accepted, or dismissed) so we do not re-nag.
 * Other botIds never become cards here. */
export function suggestionCardsFor(
  botId: string,
  items: Array<{ type: MemoryRowType; text: string }>,
  opts: { existingRows?: Array<{ botId: string; text: string }>; existingCards?: OptionCardData[] } = {},
): OptionCardData[] {
  const seen = new Set<string>();
  for (const row of opts.existingRows ?? []) {
    if (row.botId !== botId) continue;
    seen.add(normalizeNote(row.text));
  }
  for (const card of opts.existingCards ?? []) {
    if (!isSuggestionCard(card) || !card.suggestion) continue;
    if (card.suggestion.botId !== botId) continue;
    seen.add(normalizeNote(card.suggestion.text));
  }
  const out: OptionCardData[] = [];
  for (const item of items) {
    const text = item.text.trim();
    if (!text) continue;
    const key = normalizeNote(text);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(suggestionCard({ botId, type: item.type, text }));
  }
  return out;
}

export function routineInputFromWorkflow(botId: string, text: string): CreateRoutineInput {
  const prompt = text.trim();
  const name = prompt.length > 48 ? `${prompt.slice(0, 45).trimEnd()}…` : prompt;
  return {
    botId,
    name,
    prompt,
    schedule: DEFAULT_WORKFLOW_SCHEDULE,
  };
}

export type SuggestionAcceptResult =
  | { kind: "routine"; routine: RoutineRecord }
  | { kind: "memory"; row: MemoryRow }
  | { kind: "none" };

/** Apply an accepted card. Caller must have checked isSuggestionAccept.
 * Cross-bot: a card whose suggestion.botId is not this bot writes nothing. */
export function acceptSuggestion(opts: {
  botId: string;
  suggestion: SuggestionPayload;
  createRoutine: (input: CreateRoutineInput) => RoutineRecord;
}): SuggestionAcceptResult {
  if (opts.suggestion.botId !== opts.botId) return { kind: "none" };
  const text = opts.suggestion.text.trim();
  if (!text) return { kind: "none" };
  if (opts.suggestion.type === "workflow") {
    return { kind: "routine", routine: opts.createRoutine(routineInputFromWorkflow(opts.botId, text)) };
  }
  return {
    kind: "memory",
    row: insertMemoryRow({ botId: opts.botId, type: opts.suggestion.type, text }),
  };
}
