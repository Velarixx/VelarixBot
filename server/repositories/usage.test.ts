// Local provider usage totals: increment only, counts only, no secret fields.
import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "../config.ts";
import { defaultDbPath, openDatabase } from "../db/database.ts";
import type { SqliteDatabase } from "../db/sqlite-native.ts";
import { createUsageRepository, type UsageRepository } from "./usage.ts";

describe("provider usage repository", () => {
  let db: SqliteDatabase;
  let store: UsageRepository;

  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    db = openDatabase(defaultDbPath());
    store = createUsageRepository(db);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  });

  it("increments request and token counts per provider", () => {
    store.record("claudeAgent", { requests: 1, inputTokens: 12, outputTokens: 5 }, 1_000);
    store.record("claudeAgent", { requests: 1, inputTokens: 3, outputTokens: 2 }, 2_000);
    store.record("codex", { requests: 1, inputTokens: 7, outputTokens: 3 }, 3_000);
    expect(store.get("claudeAgent")).toEqual({
      provider: "claudeAgent",
      requests: 2,
      inputTokens: 15,
      outputTokens: 7,
      updatedAt: 2_000,
    });
    expect(store.list()).toEqual([
      { provider: "claudeAgent", requests: 2, inputTokens: 15, outputTokens: 7, updatedAt: 2_000 },
      { provider: "codex", requests: 1, inputTokens: 7, outputTokens: 3, updatedAt: 3_000 },
    ]);
  });

  it("ignores negative deltas and has no secret columns", () => {
    const row = store.record("fake", { requests: -4, inputTokens: -9, outputTokens: 2 }, 1);
    expect(row).toEqual({ provider: "fake", requests: 0, inputTokens: 0, outputTokens: 2, updatedAt: 1 });
    const cols = db
      .prepare<{ name: string }>("PRAGMA table_info(provider_usage)")
      .all()
      .map((c) => c.name);
    expect(cols.sort()).toEqual(["input_tokens", "output_tokens", "provider", "requests", "updated_at"]);
    expect(cols.some((name) => /secret|token$|password|dsn|key/i.test(name))).toBe(false);
  });
});
