// Memory v1: per-bot markdown + shared workspace notes, plus additive
// structured rows (preference | fact | workflow). Markdown stays at
// ~/.velarixbot/memory/{botId,workspace}.md. Rows live in SQLite
// `memory_rows`. The unused-for-runtime v1 `memory(owner, user_text,
// distilled_text)` table is left untouched as the markdown export
// snapshot — not a third store, not dual-written with rows.
//
// Inject and recall both go through composeUserKnowledge into
// "What you know about this user." Distill runs after a successful
// turn (failures swallowed). Extract returns structured suggestions
// only — PRO cards write on accept. No embeddings, no cloud, no
// secrets or prompts in logs.
//
// 2026-08-18 [VERIFY] (HEAD e85462b / #102): memoryPrompt called
// composeUserKnowledge({ bumpUse: false }) and bump ran only when a
// query was set. Inject (no query) now increments useCount on this
// bot's injected row docs. bumpRetrievedRows stays swallow-on-error.
//
// 2026-08-18 [VERIFY]: memoryDecayScore is ranking only (recency ×
// useCount, pinned +10). Eviction is separate — see
// UNCONFIRMED_IDLE_MS / decayUnconfirmedRows. No confirmed column,
// no second store, no snapshot-table dual-write. Pinned rows survive.
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { DATA_DIR } from "./config.ts";

export const MEMORY_DIR = join(DATA_DIR, "memory");
export const DISTILL_MARKER = "<!-- velarixbot:distilled -->";
export const MEMORY_CHAR_CAP = 6_000;
export const USER_KNOWLEDGE_HEADING = "What you know about this user.";
export const BM25_TOP_K = 10;
export const MEMORY_ROW_TYPES = ["preference", "fact", "workflow"] as const;

export type MemoryScope = "bot" | "workspace";
export type TextGenerator = (prompt: string) => Promise<string>;
export type MemoryRowType = (typeof MEMORY_ROW_TYPES)[number];

export function isMemoryRowType(value: string): value is MemoryRowType {
  return (MEMORY_ROW_TYPES as readonly string[]).includes(value);
}

export interface MemoryRow {
  id: string;
  botId: string;
  type: MemoryRowType;
  text: string;
  pinned: boolean;
  useCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface MemoryRowsStore {
  insert(input: {
    id?: string;
    botId: string;
    type: MemoryRowType;
    text: string;
    pinned?: boolean;
    useCount?: number;
    createdAt?: number;
    updatedAt?: number;
  }): MemoryRow;
  get(id: string): MemoryRow | null;
  listByBot(botId: string): MemoryRow[];
  update(
    id: string,
    patch: Partial<Pick<MemoryRow, "text" | "type" | "pinned" | "useCount" | "updatedAt">>,
  ): MemoryRow | null;
  delete(id: string): boolean;
  deleteByBot(botId: string): number;
}

let rowsStore: MemoryRowsStore | null = null;

/** Composition root wires the SQLite row store. Tests inject a fake. */
export function configureMemoryStore(store: MemoryRowsStore | null): void {
  rowsStore = store;
}

export function memoryRowsStore(): MemoryRowsStore | null {
  return rowsStore;
}

function safeListRows(botId: string): MemoryRow[] {
  try {
    return rowsStore?.listByBot(botId) ?? [];
  } catch {
    return [];
  }
}

export function memoryDir(): string {
  mkdirSync(MEMORY_DIR, { recursive: true });
  return MEMORY_DIR;
}

export function workspacePath(): string {
  return join(memoryDir(), "workspace.md");
}

export function botMemoryPath(botId: string): string {
  return join(memoryDir(), `${botId}.md`);
}

export function capMemory(text: string, cap = MEMORY_CHAR_CAP): string {
  if (text.length <= cap) return text;
  return text.slice(0, cap);
}

function readFileIfPresent(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

export function splitMemory(raw: string): { user: string; distilled: string } {
  const idx = raw.indexOf(DISTILL_MARKER);
  if (idx < 0) return { user: raw, distilled: "" };
  return { user: raw.slice(0, idx), distilled: raw.slice(idx + DISTILL_MARKER.length) };
}

export function joinMemory(user: string, distilled: string): string {
  const head = user.replace(/\s+$/, "");
  const tail = distilled.replace(/^\s+/, "").replace(/\s+$/, "");
  if (!tail) return head ? `${head}\n` : "";
  return `${head ? `${head}\n\n` : ""}${DISTILL_MARKER}\n${tail}\n`;
}

export function readWorkspace(): string {
  return readFileIfPresent(workspacePath());
}

export function writeWorkspace(text: string): void {
  writeFileSync(workspacePath(), capMemory(text));
}

export function readBotMemory(botId: string): { user: string; distilled: string } {
  return splitMemory(readFileIfPresent(botMemoryPath(botId)));
}

export function writeBotMemory(botId: string, parts: { user: string; distilled: string }): void {
  writeFileSync(botMemoryPath(botId), joinMemory(parts.user, parts.distilled));
}

export interface MemoryDocument {
  id: string;
  kind: "workspace" | "bot-user" | "bot-distilled" | "row";
  botId?: string;
  text: string;
  label: string;
  row?: MemoryRow;
}

/** Markdown sections + this bot's structured rows. Other botIds never appear. */
export function collectMemoryDocuments(botId: string): MemoryDocument[] {
  const docs: MemoryDocument[] = [];
  const workspace = readWorkspace().trim();
  if (workspace) {
    docs.push({
      id: "md:workspace",
      kind: "workspace",
      text: workspace,
      label: `Shared workspace notes:\n${workspace}`,
    });
  }
  const bot = readBotMemory(botId);
  const user = bot.user.trim();
  const distilled = bot.distilled.trim();
  if (user) {
    docs.push({
      id: `md:${botId}:user`,
      kind: "bot-user",
      botId,
      text: user,
      label: `Notes for this bot:\n${user}`,
    });
  }
  if (distilled) {
    docs.push({
      id: `md:${botId}:distilled`,
      kind: "bot-distilled",
      botId,
      text: distilled,
      label: `Distilled notes:\n${distilled}`,
    });
  }
  for (const row of safeListRows(botId)) {
    if (row.botId !== botId) continue;
    docs.push({
      id: row.id,
      kind: "row",
      botId,
      text: row.text,
      label: `[${row.type}] ${row.text}`,
      row,
    });
  }
  return docs;
}

const BM25_K1 = 1.2;
const BM25_B = 0.75;
const DAY_MS = 86_400_000;

/** Idle window for unconfirmed eviction.
 * Rule (2026-08-18): not pinned AND useCount === 0 (never injected)
 * AND (now - updatedAt) >= this window → delete from memory_rows.
 * Reuses pinned / useCount / updatedAt — no new column or store.
 * Pinned rows always survive extract and decay. */
export const UNCONFIRMED_IDLE_MS = 14 * DAY_MS;

/** True when decay should evict this row. Other botIds are never listed. */
export function isUnconfirmedIdle(
  row: Pick<MemoryRow, "pinned" | "useCount" | "updatedAt">,
  now: number,
): boolean {
  return !row.pinned && row.useCount === 0 && now - row.updatedAt >= UNCONFIRMED_IDLE_MS;
}

/** Evict this bot's unconfirmed idle rows. Swallow-on-error so inject
 * cannot throw out of the turn. Never deletes pinned rows or other botIds. */
export function decayUnconfirmedRows(botId: string, now = Date.now()): void {
  if (!rowsStore) return;
  try {
    for (const row of rowsStore.listByBot(botId)) {
      if (row.botId !== botId) continue;
      if (!isUnconfirmedIdle(row, now)) continue;
      try {
        rowsStore.delete(row.id);
      } catch {
        /* decay must not fail the turn */
      }
    }
  } catch {
    /* decay must not fail the turn */
  }
}

function stem(token: string): string {
  if (token.length > 4 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.length > 3 && token.endsWith("es")) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith("s")) return token.slice(0, -1);
  return token;
}

export function tokenizeMemory(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1)
    .map(stem);
}

/** Recency × use. Pinned rows keep a floor so extract/decay cannot bury them. */
export function memoryDecayScore(row: Pick<MemoryRow, "pinned" | "useCount" | "updatedAt">, now: number): number {
  const ageDays = Math.max(0, (now - row.updatedAt) / DAY_MS);
  const recency = 1 / (1 + ageDays);
  const use = 1 + Math.log1p(row.useCount);
  const base = recency * use;
  return row.pinned ? base + 10 : base;
}

export function bm25Scores(query: string, documents: string[]): number[] {
  const qTokens = tokenizeMemory(query);
  if (!qTokens.length || !documents.length) return documents.map(() => 0);
  const docs = documents.map((d) => tokenizeMemory(d));
  const avgdl = docs.reduce((sum, d) => sum + d.length, 0) / docs.length || 1;
  const df = new Map<string, number>();
  for (const tok of new Set(qTokens)) {
    df.set(tok, docs.filter((d) => d.includes(tok)).length);
  }
  const n = docs.length;
  return docs.map((tokens) => {
    if (!tokens.length) return 0;
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    let score = 0;
    for (const tok of qTokens) {
      const freq = tf.get(tok) ?? 0;
      if (!freq) continue;
      const nq = df.get(tok) ?? 0;
      const idf = Math.log((n - nq + 0.5) / (nq + 0.5) + 1);
      score += idf * ((freq * (BM25_K1 + 1)) / (freq + BM25_K1 * (1 - BM25_B + BM25_B * (tokens.length / avgdl))));
    }
    return score;
  });
}

export function rankMemoryDocuments(
  docs: MemoryDocument[],
  query: string | undefined,
  now: number,
): MemoryDocument[] {
  if (!docs.length) return [];
  if (!query?.trim()) {
    return [...docs].sort((a, b) => {
      const as = a.row ? memoryDecayScore(a.row, now) : 0;
      const bs = b.row ? memoryDecayScore(b.row, now) : 0;
      if (as !== bs) return bs - as;
      return a.id.localeCompare(b.id);
    });
  }
  const raw = bm25Scores(
    query,
    docs.map((d) => d.text),
  );
  const scored = docs.map((doc, i) => {
    const lexical = raw[i] ?? 0;
    const decay = doc.row ? memoryDecayScore(doc.row, now) : 1;
    return { doc, score: lexical * decay };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.doc.id.localeCompare(b.doc.id))
    .slice(0, BM25_TOP_K)
    .map((s) => s.doc);
}

function formatRowBlock(rows: MemoryRow[]): string {
  if (!rows.length) return "";
  return `Structured memories:\n${rows.map((r) => `- [${r.type}]${r.pinned ? " (pinned)" : ""} ${r.text}`).join("\n")}`;
}

function bumpRetrievedRows(docs: MemoryDocument[], now: number): void {
  if (!rowsStore) return;
  for (const doc of docs) {
    if (!doc.row) continue;
    try {
      rowsStore.update(doc.row.id, { useCount: doc.row.useCount + 1, updatedAt: now });
    } catch {
      /* retrieval must not fail the turn */
    }
  }
}

/**
 * Single composition function for inject + recall. Markdown files are
 * always eligible; structured rows are additive. Query uses BM25 (top 10).
 * Inject (no query) and recall both bump this bot's injected row docs
 * unless bumpUse is false. Decay runs first (unconfirmed idle only).
 */
export function composeUserKnowledge(opts: { botId: string; query?: string; now?: number; bumpUse?: boolean }): string {
  const now = opts.now ?? Date.now();
  decayUnconfirmedRows(opts.botId, now);
  const docs = collectMemoryDocuments(opts.botId);
  if (!docs.length) return opts.query?.trim() ? `No memory matching ${opts.query.trim()}.` : "";

  const query = opts.query?.trim();
  const picked = query ? rankMemoryDocuments(docs, query, now) : docs;
  if (!picked.length) return query ? `No memory matching ${query}.` : "";
  // 2026-08-18 [VERIFY]: #102 gated this on `query`. Inject (memoryPrompt /
  // startTurn / composeUserKnowledge without query) now bumps too.
  if (opts.bumpUse !== false) bumpRetrievedRows(picked, now);

  const chunks: string[] = [];
  const workspace = picked.find((d) => d.kind === "workspace");
  if (workspace) chunks.push(workspace.label);
  const user = picked.find((d) => d.kind === "bot-user");
  const distilled = picked.find((d) => d.kind === "bot-distilled");
  if (query) {
    if (user) chunks.push(user.label);
    if (distilled) chunks.push(distilled.label);
  } else {
    const botBits = [user?.text, distilled?.text].filter(Boolean).join("\n\n");
    if (botBits) chunks.push(`Memory for this bot:\n${botBits}`);
  }
  const rows = picked.filter((d) => d.kind === "row" && d.row).map((d) => d.row!);
  const rowBlock = formatRowBlock(rows);
  if (rowBlock) chunks.push(rowBlock);
  if (!chunks.length) return query ? `No memory matching ${query}.` : "";
  return capMemory(`\n\n${USER_KNOWLEDGE_HEADING}\n\n${chunks.join("\n\n")}`);
}

/** System-prompt fragment. Empty when neither markdown nor rows have content.
 * 2026-08-18 [VERIFY]: #102 passed bumpUse: false; inject now increments
 * useCount on this bot's injected row docs (swallow-on-error). */
export function memoryPrompt(botId: string, now?: number): string {
  return composeUserKnowledge({ botId, now });
}

const DISTILL_INSTRUCTIONS =
  "You distill durable notes for a personal bot. Update the existing distilled memory with lasting facts, preferences, and decisions from this turn. Drop chit-chat and secrets. Reply with only the updated notes, no heading or markdown fence.";

export function distillPrompt(existingDistilled: string, turnText: string): string {
  const prior = capMemory(existingDistilled.trim(), 3_000);
  const turn = capMemory(turnText.trim(), 4_000);
  return [
    DISTILL_INSTRUCTIONS,
    prior ? `Existing distilled notes:\n${prior}` : "Existing distilled notes: (none)",
    `Turn:\n${turn}`,
  ].join("\n\n");
}

const EXTRACT_INSTRUCTIONS =
  'You extract durable structured memories for a personal bot. Reply with only a JSON array, no heading or markdown fence. Each item is {"type":"preference"|"fact"|"workflow","text":"one short note"}. Skip chit-chat and secrets. Empty array if nothing durable.';

export function extractPrompt(turnText: string): string {
  return [EXTRACT_INSTRUCTIONS, `Turn:\n${capMemory(turnText.trim(), 4_000)}`].join("\n\n");
}

/** Prefer the bot's own generateText; otherwise any other live hook
 * (Claude CLI or Grok-API). Empty chain → undefined (distill/extract skip). */
export function fleetGenerateText(
  instances: Array<{ instanceId: string; generateText?: TextGenerator }>,
  preferredInstanceId?: string,
): TextGenerator | undefined {
  const capable = instances.filter((i) => typeof i.generateText === "function");
  const preferred = capable.find((i) => i.instanceId === preferredInstanceId);
  const chain = preferred ? [preferred, ...capable.filter((i) => i !== preferred)] : capable;
  if (!chain.length) return undefined;
  return async (prompt: string) => {
    let lastError: unknown;
    for (const inst of chain) {
      try {
        const out = (await inst.generateText!(prompt)).trim();
        if (out) return out;
      } catch (e) {
        lastError = e;
      }
    }
    if (lastError) throw lastError;
    return "";
  };
}

/** After a successful turn. Missing hook or generateText failure is a skip. */
export async function distillMemory(opts: {
  botId: string;
  turnText: string;
  generateText?: TextGenerator;
}): Promise<void> {
  if (!opts.generateText) return;
  const turnText = opts.turnText.trim();
  if (!turnText) return;
  try {
    const existing = readBotMemory(opts.botId);
    const out = (await opts.generateText(distillPrompt(existing.distilled, turnText))).trim();
    if (!out) return;
    writeBotMemory(opts.botId, { user: existing.user, distilled: capMemory(out) });
  } catch {
    /* distill failure must not fail the turn — and must not log the prompt */
  }
}

export function parseExtractedRows(raw: string): Array<{ type: MemoryRowType; text: string }> {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  const start = trimmed.indexOf("[");
  const end = trimmed.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: Array<{ type: MemoryRowType; text: string }> = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const rec = item as { type?: unknown; text?: unknown };
    const type = typeof rec.type === "string" ? rec.type : "";
    const text = typeof rec.text === "string" ? rec.text.trim() : "";
    if (!isMemoryRowType(type) || !text) continue;
    out.push({ type, text });
  }
  return out;
}

function normalizeNote(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/** After a successful turn, same swallow-failure contract as distill.
 * Returns structured suggestions only — never writes a row or routine.
 * PRO cards accept through insertMemoryRow / createRoutine. */
export async function extractMemory(opts: {
  botId: string;
  turnText: string;
  generateText?: TextGenerator;
  /** Kept so existing callers can pass a clock; extract no longer writes. */
  now?: number;
}): Promise<Array<{ type: MemoryRowType; text: string }>> {
  if (!opts.generateText) return [];
  const turnText = opts.turnText.trim();
  if (!turnText) return [];
  try {
    const out = (await opts.generateText(extractPrompt(turnText))).trim();
    if (!out) return [];
    const items = parseExtractedRows(out);
    if (!items.length) return [];
    const existing = safeListRows(opts.botId);
    const suggestions: Array<{ type: MemoryRowType; text: string }> = [];
    for (const item of items) {
      const match = existing.find((row) => row.botId === opts.botId && normalizeNote(row.text) === normalizeNote(item.text));
      if (match) continue;
      suggestions.push(item);
    }
    return suggestions;
  } catch {
    /* extract failure must not fail the turn — and must not log the prompt */
    return [];
  }
}

export function rememberNote(botId: string, note: string, scope: MemoryScope = "bot"): void {
  const text = note.trim();
  if (!text) return;
  if (scope === "workspace") {
    const existing = readWorkspace().replace(/\s+$/, "");
    writeWorkspace(existing ? `${existing}\n${text}\n` : `${text}\n`);
    return;
  }
  const parts = readBotMemory(botId);
  const user = parts.user.replace(/\s+$/, "");
  writeBotMemory(botId, { user: user ? `${user}\n${text}` : text, distilled: parts.distilled });
}

/** BM25 recall over markdown sections + this bot's rows. No embeddings. */
export function recallMemory(botId: string, query?: string, now?: number): string {
  const composed = composeUserKnowledge({ botId, query, now });
  if (!composed) return "(no memory yet)";
  return composed;
}

export function insertMemoryRow(input: {
  botId: string;
  type: MemoryRowType;
  text: string;
  pinned?: boolean;
  useCount?: number;
  id?: string;
  now?: number;
}): MemoryRow {
  if (!rowsStore) throw new Error("memory row store is not configured");
  const now = input.now ?? Date.now();
  return rowsStore.insert({
    id: input.id,
    botId: input.botId,
    type: input.type,
    text: input.text,
    pinned: input.pinned,
    useCount: input.useCount,
    createdAt: now,
    updatedAt: now,
  });
}

export function pinMemoryRow(id: string, pinned = true, now?: number): MemoryRow | null {
  if (!rowsStore) return null;
  return rowsStore.update(id, { pinned, updatedAt: now ?? Date.now() });
}

export function editMemoryRow(id: string, text: string, now?: number): MemoryRow | null {
  if (!rowsStore) return null;
  return rowsStore.update(id, { text, updatedAt: now ?? Date.now() });
}

export function deleteMemoryRow(id: string): boolean {
  return rowsStore?.delete(id) ?? false;
}

export function listMemoryRows(botId: string): MemoryRow[] {
  return safeListRows(botId);
}

/** Per-bot forget. Does not wipe workspace.md unless scope is workspace. */
export function forgetEverything(botId: string, scope: MemoryScope = "bot"): void {
  try {
    rowsStore?.deleteByBot(botId);
  } catch {
    /* missing store is fine */
  }
  deleteBotMemory(botId);
  if (scope === "workspace") writeWorkspace("");
}

export function deleteBotMemory(botId: string): void {
  try {
    unlinkSync(botMemoryPath(botId));
  } catch {
    /* missing is fine */
  }
  try {
    rowsStore?.deleteByBot(botId);
  } catch {
    /* missing store is fine */
  }
}

/** Collect recent user/assistant text for a distill/extract prompt. */
export function turnTextFromMessages(
  messages: Array<{ role: string; kind: string; text?: string }>,
  limit = 20,
): string {
  return messages
    .filter((m) => m.kind === "text" && m.text?.trim())
    .slice(-limit)
    .map((m) => `${m.role === "user" ? "User" : "Bot"}: ${m.text!.trim()}`)
    .join("\n\n");
}
