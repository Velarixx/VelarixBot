// Request lineage persistence: one id, idempotent source refs, bounded
// error column, no secret-shaped fields. Isolated HOME via setup.
import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "../config.ts";
import { defaultDbPath, openDatabase } from "../db/database.ts";
import type { SqliteDatabase } from "../db/sqlite-native.ts";
import { createLineageRepository, LINEAGE_ERROR_MAX, type LineageRepository } from "./lineage.ts";

describe("request lineage repository", () => {
  let db: SqliteDatabase;
  let store: LineageRepository;

  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    db = openDatabase(defaultDbPath());
    store = createLineageRepository(db);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  });

  it("inserts a row and finds it by id and source ref", () => {
    const row = store.insert({
      requestId: "req-1",
      source: "channel",
      sourceRef: "discord:msg-1",
      botId: "bot-a",
      createdAt: 1_000,
    });
    expect(row).toMatchObject({ requestId: "req-1", source: "channel", sourceRef: "discord:msg-1", botId: "bot-a" });
    expect(store.get("req-1")?.requestId).toBe("req-1");
    expect(store.getBySourceRef("channel", "discord:msg-1")?.requestId).toBe("req-1");
  });

  it("patches turn and outbound without inventing extra columns", () => {
    store.insert({ requestId: "req-2", source: "user", createdAt: 1_000 });
    expect(store.patch("req-2", { threadId: "t-1", turnId: "turn-9", outboundId: "out-3" }, 2_000)).toBe(true);
    const row = store.get("req-2")!;
    expect(row).toMatchObject({ threadId: "t-1", turnId: "turn-9", outboundId: "out-3", updatedAt: 2_000 });
    expect(Object.keys(row).sort()).toEqual(
      ["createdAt", "outboundId", "requestId", "source", "threadId", "turnId", "updatedAt"].sort(),
    );
  });

  it("appends steps in order and rejects a missing request", () => {
    store.insert({ requestId: "req-3", source: "user", createdAt: 1 });
    store.addStep({ requestId: "req-3", kind: "inbound", detail: "user", createdAt: 1 });
    store.addStep({ requestId: "req-3", kind: "turn", ref: "turn-1", createdAt: 2 });
    store.addStep({ requestId: "req-3", kind: "tool", ref: "item-1", detail: "web_search", createdAt: 3 });
    expect(store.addStep({ requestId: "missing", kind: "error", detail: "nope", createdAt: 4 })).toBeNull();
    expect(store.steps("req-3").map((s) => s.kind)).toEqual(["inbound", "turn", "tool"]);
  });

  it("accepts a bounded error and no secret-named columns exist", () => {
    store.insert({ requestId: "req-4", source: "user", createdAt: 1 });
    const error = "x".repeat(LINEAGE_ERROR_MAX);
    expect(store.patch("req-4", { error }, 2)).toBe(true);
    expect(store.get("req-4")?.error).toBe(error);
    const cols = db
      .prepare<{ name: string }>("PRAGMA table_info(request_lineage)")
      .all()
      .map((c) => c.name);
    expect(cols.some((name) => /token|secret|password|dsn|key/i.test(name))).toBe(false);
  });
});
