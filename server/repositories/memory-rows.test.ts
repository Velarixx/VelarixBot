import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "../config.ts";

import { defaultDbPath, openDatabase } from "../db/database.ts";
import {
  configureMemoryStore,
  deleteMemoryRow,
  editMemoryRow,
  decayUnconfirmedRows,
  extractMemory,
  forgetEverything,
  insertMemoryRow,
  isMemoryRowType,
  listMemoryRows,
  memoryDecayScore,
  pinMemoryRow,
  UNCONFIRMED_IDLE_MS,
  readWorkspace,
  rememberNote,
  writeWorkspace,
} from "../memory.ts";
import type { SqliteDatabase } from "../db/sqlite-native.ts";
import { createRepositories } from "./index.ts";

const BOT = "bot-rows-1";
const OTHER = "bot-rows-2";

describe("memory_rows store", () => {
  let db: SqliteDatabase;

  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    db = openDatabase(defaultDbPath());
    configureMemoryStore(createRepositories(db).memoryRows);
    writeWorkspace("");
  });

  afterEach(() => {
    configureMemoryStore(null);
    try {
      db.close();
    } catch {
      /* already closed */
    }
  });

  it("accepts only preference | fact | workflow", () => {
    expect(isMemoryRowType("preference")).toBe(true);
    expect(isMemoryRowType("fact")).toBe(true);
    expect(isMemoryRowType("workflow")).toBe(true);
    expect(isMemoryRowType("secret")).toBe(false);
    expect(() => insertMemoryRow({ botId: BOT, type: "secret" as "fact", text: "nope" })).toThrow(/type/i);
    const row = insertMemoryRow({ botId: BOT, type: "fact", text: "Lives in Austin." });
    expect(row.type).toBe("fact");
    expect(listMemoryRows(BOT)).toHaveLength(1);
  });

  it("pins, edits, and deletes a row", () => {
    const row = insertMemoryRow({ botId: BOT, type: "preference", text: "Call me Sam.", now: 1_000 });
    const pinned = pinMemoryRow(row.id, true, 2_000);
    expect(pinned?.pinned).toBe(true);
    const edited = editMemoryRow(row.id, "Call me Samuel.", 3_000);
    expect(edited?.text).toBe("Call me Samuel.");
    expect(edited?.pinned).toBe(true);
    expect(deleteMemoryRow(row.id)).toBe(true);
    expect(listMemoryRows(BOT)).toEqual([]);
    expect(deleteMemoryRow(row.id)).toBe(false);
  });

  it("forget-everything clears that bot's rows and markdown, not workspace.md", () => {
    rememberNote(BOT, "Keep this bot note.");
    rememberNote(BOT, "Team ships on Fridays.", "workspace");
    insertMemoryRow({ botId: BOT, type: "fact", text: "Lives in Austin." });
    insertMemoryRow({ botId: OTHER, type: "fact", text: "Other bot fact." });
    expect(readWorkspace()).toContain("Team ships on Fridays.");

    forgetEverything(BOT);
    expect(listMemoryRows(BOT)).toEqual([]);
    expect(listMemoryRows(OTHER)).toHaveLength(1);
    expect(readWorkspace()).toContain("Team ships on Fridays.");

    forgetEverything(BOT, "workspace");
    expect(readWorkspace().trim()).toBe("");
  });

  it("decay scores recency and use; pinned stays above a stale unused twin", () => {
    const now = 10 * 86_400_000;
    const stale = { pinned: false, useCount: 0, updatedAt: 0 };
    const used = { pinned: false, useCount: 4, updatedAt: now };
    const pinned = { pinned: true, useCount: 0, updatedAt: 0 };
    expect(memoryDecayScore(used, now)).toBeGreaterThan(memoryDecayScore(stale, now));
    expect(memoryDecayScore(pinned, now)).toBeGreaterThan(memoryDecayScore(stale, now));
  });

  // 2026-08-18: unconfirmed = not pinned AND useCount === 0 past
  // UNCONFIRMED_IDLE_MS (14d). Pin must survive extract and decay.
  it("pin survives decay of an unconfirmed idle twin", () => {
    const now = UNCONFIRMED_IDLE_MS + 5_000;
    const pinned = insertMemoryRow({
      botId: BOT,
      type: "preference",
      text: "Call me Sam.",
      pinned: true,
      now: 0,
    });
    insertMemoryRow({ botId: BOT, type: "fact", text: "Unused stale note.", now: 0 });
    insertMemoryRow({ botId: OTHER, type: "fact", text: "Other bot stale.", now: 0 });
    decayUnconfirmedRows(BOT, now);
    const after = listMemoryRows(BOT);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: pinned.id, pinned: true, text: "Call me Sam.", useCount: 0 });
    expect(listMemoryRows(OTHER)).toHaveLength(1);
  });

  it("pin survives extract that would rewrite the same note", async () => {
    const pinned = insertMemoryRow({
      botId: BOT,
      type: "preference",
      text: "Call me Sam.",
      pinned: true,
      now: 1_000,
    });
    await extractMemory({
      botId: BOT,
      turnText: "User: actually call me Alex.",
      generateText: async () => JSON.stringify([{ type: "preference", text: "Call me Sam." }]),
      now: 2_000,
    });
    const after = listMemoryRows(BOT);
    expect(after).toHaveLength(1);
    expect(after[0]?.id).toBe(pinned.id);
    expect(after[0]?.text).toBe("Call me Sam.");
    expect(after[0]?.pinned).toBe(true);
  });

  it("extract failure is swallowed and does not throw", async () => {
    insertMemoryRow({ botId: BOT, type: "fact", text: "Stay." });
    await expect(
      extractMemory({
        botId: BOT,
        turnText: "hello",
        generateText: async () => {
          throw new Error("haiku down");
        },
      }),
    ).resolves.toEqual([]);
    expect(listMemoryRows(BOT)[0]?.text).toBe("Stay.");
  });
});
