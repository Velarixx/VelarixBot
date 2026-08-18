import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";

import {
  BM25_TOP_K,
  DISTILL_MARKER,
  USER_KNOWLEDGE_HEADING,
  botMemoryPath,
  capMemory,
  composeUserKnowledge,
  configureMemoryStore,
  decayUnconfirmedRows,
  distillMemory,
  extractMemory,
  fleetGenerateText,
  insertMemoryRow,
  joinMemory,
  listMemoryRows,
  memoryPrompt,
  pinMemoryRow,
  UNCONFIRMED_IDLE_MS,
  readBotMemory,
  readWorkspace,
  recallMemory,
  rememberNote,
  splitMemory,
  turnTextFromMessages,
  workspacePath,
  writeBotMemory,
  writeWorkspace,
  type MemoryRow,
  type MemoryRowsStore,
} from "./memory.ts";

function createTestRowStore(): MemoryRowsStore {
  const rows = new Map<string, MemoryRow>();
  let n = 0;
  return {
    insert(input) {
      const now = input.createdAt ?? 1;
      const row: MemoryRow = {
        id: input.id ?? `row-${++n}`,
        botId: input.botId,
        type: input.type,
        text: input.text.trim(),
        pinned: input.pinned === true,
        useCount: input.useCount ?? 0,
        createdAt: now,
        updatedAt: input.updatedAt ?? now,
      };
      rows.set(row.id, row);
      return row;
    },
    get(id) {
      return rows.get(id) ?? null;
    },
    listByBot(botId) {
      return [...rows.values()].filter((r) => r.botId === botId);
    },
    update(id, patch) {
      const existing = rows.get(id);
      if (!existing) return null;
      const next = { ...existing, ...patch };
      rows.set(id, next);
      return next;
    },
    delete(id) {
      return rows.delete(id);
    },
    deleteByBot(botId) {
      let count = 0;
      for (const [id, row] of rows) {
        if (row.botId === botId) {
          rows.delete(id);
          count++;
        }
      }
      return count;
    },
  };
}

const BOT = "bot-memory-1";

beforeEach(() => {
  configureMemoryStore(createTestRowStore());
  mkdirSync(join(DATA_DIR, "memory"), { recursive: true });
  writeFileSync(workspacePath(), "");
  writeFileSync(botMemoryPath(BOT), "");
});

afterEach(() => {
  configureMemoryStore(null);
});

describe("memory files", () => {
  it("splits user notes from distilled notes at the marker", () => {
    const raw = `Keep my timezone.\n\n${DISTILL_MARKER}\nLikes short answers.\n`;
    expect(splitMemory(raw)).toEqual({ user: "Keep my timezone.\n\n", distilled: "\nLikes short answers.\n" });
    expect(joinMemory("Keep my timezone.", "Likes short answers.")).toContain("Keep my timezone.");
    expect(joinMemory("Keep my timezone.", "Likes short answers.")).toContain(DISTILL_MARKER);
  });

  it("injects workspace.md and the per-bot file into startTurn, capped", () => {
    writeFileSync(workspacePath(), "Team ships on Fridays.");
    writeBotMemory(BOT, { user: "Call me Sam.", distilled: "Prefers bullet lists." });
    const prompt = memoryPrompt(BOT);
    expect(prompt).toContain("Team ships on Fridays.");
    expect(prompt).toContain("Call me Sam.");
    expect(prompt).toContain("Prefers bullet lists.");

    writeFileSync(workspacePath(), "W".repeat(20_000));
    expect(memoryPrompt(BOT).includes("W".repeat(20_000))).toBe(false);
    expect(capMemory("x".repeat(10)).length).toBe(10);
  });

  it("distills below the marker and preserves the user section", async () => {
    writeBotMemory(BOT, { user: "Never change this.", distilled: "old note" });
    await distillMemory({
      botId: BOT,
      turnText: "User: I moved to Austin.\n\nBot: Got it.",
      generateText: async () => "Lives in Austin.",
    });
    const after = readBotMemory(BOT);
    expect(after.user).toContain("Never change this.");
    expect(after.distilled).toContain("Lives in Austin.");
    expect(after.distilled).not.toContain("old note");
  });

  it("skips distill when there is no generateText hook, and a thrown hook does not fail the turn", async () => {
    writeBotMemory(BOT, { user: "Stay.", distilled: "" });
    await expect(distillMemory({ botId: BOT, turnText: "hello" })).resolves.toBeUndefined();
    expect(readBotMemory(BOT).user).toContain("Stay.");
    expect(readBotMemory(BOT).distilled).toBe("");

    await expect(
      distillMemory({
        botId: BOT,
        turnText: "hello",
        generateText: async () => {
          throw new Error("haiku down");
        },
      }),
    ).resolves.toBeUndefined();
    expect(readBotMemory(BOT).user).toContain("Stay.");
  });

  it("builds turn text from settled messages", () => {
    expect(
      turnTextFromMessages([
        { role: "user", kind: "text", text: "hi" },
        { role: "bot", kind: "activity", text: "tool" },
        { role: "bot", kind: "text", text: "hello" },
      ]),
    ).toBe("User: hi\n\nBot: hello");
  });

  it("writes workspace.md and remember/recall round-trip bot + workspace notes", () => {
    rememberNote(BOT, "Call me Sam.");
    rememberNote(BOT, "Team ships on Fridays.", "workspace");
    expect(existsSync(workspacePath())).toBe(true);
    expect(readWorkspace()).toContain("Team ships on Fridays.");
    expect(readBotMemory(BOT).user).toContain("Call me Sam.");

    const all = recallMemory(BOT);
    expect(all).toContain("Call me Sam.");
    expect(all).toContain("Team ships on Fridays.");
    expect(recallMemory(BOT, "friday")).toContain("Team ships on Fridays.");
    expect(recallMemory(BOT, "friday")).not.toContain("Call me Sam.");
    expect(recallMemory(BOT, "xyzzy")).toContain("No memory matching");

    writeWorkspace("Edited in settings.");
    expect(readWorkspace()).toContain("Edited in settings.");
  });

  it("picks any capable generateText, not only the bot's own driver", async () => {
    const calls: string[] = [];
    const claude = {
      instanceId: "claude",
      generateText: async (prompt: string) => {
        calls.push(`claude:${prompt.slice(0, 8)}`);
        return "Lives in Austin.";
      },
    };
    const codex = { instanceId: "codex" };
    const grok = {
      instanceId: "grok",
      generateText: async () => {
        throw new Error("xai down");
      },
    };

    expect(fleetGenerateText([codex], "codex")).toBeUndefined();

    const viaClaude = fleetGenerateText([codex, claude], "codex");
    expect(viaClaude).toBeTypeOf("function");
    await distillMemory({ botId: BOT, turnText: "User: I moved to Austin.", generateText: viaClaude });
    expect(readBotMemory(BOT).distilled).toContain("Lives in Austin.");
    expect(calls.some((c) => c.startsWith("claude:"))).toBe(true);

    const fallback = fleetGenerateText([grok, claude], "grok");
    await expect(fallback!("ping")).resolves.toBe("Lives in Austin.");
  });

  it("composes markdown and structured rows through one function", () => {
    writeWorkspace("Team ships on Fridays.");
    writeBotMemory(BOT, { user: "Call me Sam.", distilled: "Prefers bullet lists." });
    insertMemoryRow({ botId: BOT, type: "fact", text: "Current city is Austin.", now: 5_000 });
    const composed = composeUserKnowledge({ botId: BOT, now: 5_000, bumpUse: false });
    expect(composed).toContain(USER_KNOWLEDGE_HEADING);
    expect(composed).toContain("Team ships on Fridays.");
    expect(composed).toContain("Call me Sam.");
    expect(composed).toContain("Current city is Austin.");
    expect(composeUserKnowledge({ botId: BOT, now: 5_000, bumpUse: false })).toBe(composed);
  });

  it("inject (memoryPrompt / composeUserKnowledge without query) increments useCount on this bot's injected row docs", () => {
    const now = 5_000;
    const mine = insertMemoryRow({ botId: BOT, type: "fact", text: "Current city is Austin.", now });
    const other = insertMemoryRow({ botId: "bot-other", type: "fact", text: "Ops alias is pager-lee in Austin.", now });
    expect(listMemoryRows(BOT)[0]?.useCount).toBe(0);
    expect(listMemoryRows("bot-other")[0]?.useCount).toBe(0);

    const prompt = memoryPrompt(BOT, now);
    expect(prompt).toContain("Current city is Austin.");
    expect(prompt).not.toContain("pager-lee");
    expect(listMemoryRows(BOT).find((r) => r.id === mine.id)?.useCount).toBe(1);
    expect(listMemoryRows("bot-other").find((r) => r.id === other.id)?.useCount).toBe(0);

    composeUserKnowledge({ botId: BOT, now });
    expect(listMemoryRows(BOT).find((r) => r.id === mine.id)?.useCount).toBe(2);
    expect(listMemoryRows("bot-other").find((r) => r.id === other.id)?.useCount).toBe(0);

    composeUserKnowledge({ botId: BOT, now, bumpUse: false });
    expect(listMemoryRows(BOT).find((r) => r.id === mine.id)?.useCount).toBe(2);
  });

  it("inject bump swallows store errors and cannot throw out of the turn", () => {
    const inner = createTestRowStore();
    configureMemoryStore({
      ...inner,
      update() {
        throw new Error("store down");
      },
    });
    insertMemoryRow({ botId: BOT, type: "fact", text: "Current city is Austin.", now: 1 });
    expect(() => memoryPrompt(BOT, 1)).not.toThrow();
    expect(() => composeUserKnowledge({ botId: BOT, now: 1 })).not.toThrow();
    expect(memoryPrompt(BOT, 1)).toContain("Current city is Austin.");
  });

  it("decay evicts unconfirmed idle rows and never deletes pinned or other botId", () => {
    const now = UNCONFIRMED_IDLE_MS + 1_000;
    const stale = insertMemoryRow({ botId: BOT, type: "fact", text: "Stale unused fact.", now: 0 });
    const pinned = insertMemoryRow({
      botId: BOT,
      type: "preference",
      text: "Call me Sam.",
      pinned: true,
      now: 0,
    });
    const used = insertMemoryRow({ botId: BOT, type: "workflow", text: "Check PRs weekdays.", useCount: 1, now: 0 });
    const fresh = insertMemoryRow({ botId: BOT, type: "fact", text: "Just written.", now });
    const other = insertMemoryRow({ botId: "bot-other", type: "fact", text: "Other bot stale.", now: 0 });

    composeUserKnowledge({ botId: BOT, now, bumpUse: false });
    const mine = listMemoryRows(BOT);
    expect(mine.map((r) => r.id)).not.toContain(stale.id);
    expect(mine.find((r) => r.id === pinned.id)).toMatchObject({ pinned: true, text: "Call me Sam." });
    expect(mine.find((r) => r.id === used.id)?.text).toBe("Check PRs weekdays.");
    expect(mine.find((r) => r.id === fresh.id)?.text).toBe("Just written.");
    expect(listMemoryRows("bot-other").map((r) => r.id)).toEqual([other.id]);

    decayUnconfirmedRows("bot-other", now);
    expect(listMemoryRows("bot-other")).toEqual([]);
    expect(listMemoryRows(BOT).find((r) => r.id === pinned.id)?.pinned).toBe(true);
  });

  it("BM25 top-10 includes the right fact, excludes stale, excludes other botId", () => {
    const now = 8 * 86_400_000;
    insertMemoryRow({ botId: BOT, type: "fact", text: "Current city is Austin.", now });
    insertMemoryRow({
      botId: BOT,
      type: "fact",
      text: "Obsolete listing: Berlin office closed.",
      now: 1_000,
    });
    insertMemoryRow({ botId: "bot-other", type: "fact", text: "Ops alias is pager-lee in Austin.", now });
    for (let i = 0; i < 12; i++) {
      insertMemoryRow({ botId: BOT, type: "workflow", text: `Filler checklist step ${i} about snacks.`, now });
    }
    const recalled = recallMemory(BOT, "Austin city", now);
    expect(recalled).toContain("Austin");
    expect(recalled).not.toContain("Berlin");
    expect(recalled).not.toContain("pager-lee");
    const hits = (recalled.match(/\[(preference|fact|workflow)\]/g) ?? []).length;
    expect(hits).toBeLessThanOrEqual(BM25_TOP_K);
  });

  it("skips extract when there is no generateText hook, and a thrown hook does not fail the turn", async () => {
    await expect(extractMemory({ botId: BOT, turnText: "hello" })).resolves.toEqual([]);
    expect(listMemoryRows(BOT)).toEqual([]);
    await expect(
      extractMemory({
        botId: BOT,
        turnText: "hello",
        generateText: async () => {
          throw new Error("haiku down");
        },
      }),
    ).resolves.toEqual([]);
    expect(listMemoryRows(BOT)).toEqual([]);
  });

  it("extract returns suggestions and does not write rows", async () => {
    const pinned = insertMemoryRow({ botId: BOT, type: "preference", text: "Call me Sam.", pinned: true, now: 1 });
    const items = await extractMemory({
      botId: BOT,
      turnText: "User: I moved to Austin.\n\nBot: Got it.",
      generateText: async () =>
        JSON.stringify([
          { type: "preference", text: "Call me Sam." },
          { type: "fact", text: "Lives in Austin." },
        ]),
      now: 2,
    });
    expect(items).toEqual([{ type: "fact", text: "Lives in Austin." }]);
    const rows = listMemoryRows(BOT);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: pinned.id, pinned: true, text: "Call me Sam." });
    pinMemoryRow(pinned.id, true);
    expect(listMemoryRows(BOT).find((r) => r.id === pinned.id)?.pinned).toBe(true);
  });

  it("does not log distill or extract prompts", () => {
    const src = readFileSync(fileURLToPath(import.meta.url), "utf8");
    const impl = readFileSync(new URL("./memory.ts", import.meta.url), "utf8");
    const turns = readFileSync(new URL("./services/turns.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/console\.(log|info|debug|dir|table)\(/);
    expect(impl).not.toMatch(/console\.(log|info|debug|dir|table)\(/);
    expect(impl).toMatch(/must not log the prompt/);
    expect(turns).toMatch(/if \(event\.ok\) \{[\s\S]*extractMemory/);
    expect(turns).toMatch(/void \(async \(\) => \{[\s\S]*extractMemory/);
    expect(turns).toMatch(/suggestionItemsFromRepeatedWorkflows/);
    expect(turns).toMatch(/memoryPrompt\(bot\.id\)/);
  });
});
