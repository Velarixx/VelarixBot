// Memory v1: per-bot markdown + shared workspace notes, injected into
// startTurn and optionally distilled after a successful turn. Distill
// uses any live generateText hook in the fleet (Claude or Grok-API), not
// only the bot's own driver — Codex/ACP/Box still get a memory file when
// another capable instance exists. remember/recall and the settings
// editor write the same files. ~/.velarixbot/memory/. No embeddings, no
// cloud, no secrets in logs.
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { DATA_DIR } from "./config.ts";

export const MEMORY_DIR = join(DATA_DIR, "memory");
export const DISTILL_MARKER = "<!-- velarixbot:distilled -->";
export const MEMORY_CHAR_CAP = 6_000;

export type MemoryScope = "bot" | "workspace";
export type TextGenerator = (prompt: string) => Promise<string>;

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

/** System-prompt fragment. Empty when neither file has content. */
export function memoryPrompt(botId: string): string {
  const workspace = capMemory(readWorkspace().trim());
  const bot = readBotMemory(botId);
  const user = capMemory(bot.user.trim());
  const distilled = capMemory(bot.distilled.trim());
  const chunks: string[] = [];
  if (workspace) chunks.push(`Shared workspace notes:\n${workspace}`);
  const botBits = [user, distilled].filter(Boolean).join("\n\n");
  if (botBits) chunks.push(`Memory for this bot:\n${botBits}`);
  return chunks.length ? `\n\n${chunks.join("\n\n")}` : "";
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

/** Prefer the bot's own generateText; otherwise any other live hook
 * (Claude CLI or Grok-API). Empty chain → undefined (distill skips). */
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

/** Plain-text recall. Optional query is a case-insensitive substring filter
 * over chunks — no embeddings. */
export function recallMemory(botId: string, query?: string): string {
  const workspace = readWorkspace().trim();
  const bot = readBotMemory(botId);
  const user = bot.user.trim();
  const distilled = bot.distilled.trim();
  const chunks: string[] = [];
  if (workspace) chunks.push(`Shared workspace notes:\n${workspace}`);
  if (user) chunks.push(`Notes for this bot:\n${user}`);
  if (distilled) chunks.push(`Distilled notes:\n${distilled}`);
  if (!chunks.length) return "(no memory yet)";
  const q = query?.trim().toLowerCase();
  const picked = q ? chunks.filter((c) => c.toLowerCase().includes(q)) : chunks;
  if (!picked.length) return `No memory matching ${query!.trim()}.`;
  return capMemory(picked.join("\n\n"));
}

export function deleteBotMemory(botId: string): void {
  try {
    unlinkSync(botMemoryPath(botId));
  } catch {
    /* missing is fine */
  }
}

/** Collect recent user/assistant text for a distill prompt. */
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
