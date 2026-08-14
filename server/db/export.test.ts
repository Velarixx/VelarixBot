// NDJSON export / restore round-trip, verified the way CI runs it: build a
// populated database, export, restore into a FRESH database, compare every
// table — plus checksum tamper detection.
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "../config.ts";
import { createRepositories, type Repositories } from "../repositories/index.ts";
import { openDatabase } from "./database.ts";
import { EXPORT_TABLES, exportNdjson, restoreNdjson } from "./export.ts";
import type { SqliteDatabase } from "./sqlite-native.ts";

const PNG_BASE64 = Buffer.from("export-me-bytes").toString("base64");

function populate(repos: Repositories): void {
  repos.bots.insert({
    id: "bot-1",
    threadId: "thread-1",
    name: "Exported",
    title: "",
    description: "",
    notifications: true,
    color: "blue",
    iconShape: "cursor",
    unread: false,
    modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
    resumeCursors: {},
    computer: "off",
    busy: false,
    state: "IDLE",
    usage: { input: 0, output: 0, cost: null },
    createdAt: 1_700_000_000_000,
  });
  repos.messages.append("thread-1", { role: "user", kind: "text", text: "hello" });
  repos.messages.append("thread-1", { role: "bot", kind: "screen", png: PNG_BASE64, mime: "image/png" });
  repos.eventLog.append({
    eventId: "ev-1",
    provider: "claudeAgent",
    threadId: "thread-1",
    createdAt: "2026-01-01T00:00:00Z",
    type: "turn.started",
  });
  repos.routines.insert({
    id: "routine-1",
    botId: "bot-1",
    name: "R",
    prompt: "P",
    schedule: { kind: "weekdays", time: "09:00" },
    enabled: true,
    running: false,
    nextRunAt: 1_700_000_100_000,
    lastRunAt: null,
    lastResult: null,
    createdAt: 1_700_000_000_000,
    missedPolicy: "run-once",
  });
  const run = repos.routines.claimRun({
    routineId: "routine-1",
    botId: "bot-1",
    startedAt: 1_000,
    leaseUntil: 61_000,
    kind: "scheduled",
    scheduledFor: 1_000,
    idempotencyKey: "routine-1@1000",
  });
  repos.routines.finishRun(run!.seq, "done", "DONE", 2_000);
  repos.computerBindings.record("bot-1", "box-1", 3_000);
  repos.snapshots.replaceApprovalRules([
    { scope: "bot-1", rule: { id: "rule-1", tool: "Bash", pattern: "git status", action: "allow", createdAt: 5, confirmed: true } },
  ]);
  repos.snapshots.replaceApprovalAudit([{ at: 6, bot: "bot-1", tool: "Bash", matcher: "git status", decision: "user.allow", ruleId: "rule-1" }]);
  repos.snapshots.replaceSkills([{ id: "skill-1", name: "S", botId: "bot-1", markdown: "# S\n", createdAt: 7 }]);
  repos.snapshots.replaceMemory([{ owner: "_workspace", user: "Notes.", distilled: "", updatedAt: 8 }]);
}

function dumpAll(db: SqliteDatabase): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const { table, columns } of EXPORT_TABLES) {
    out[table] = db.prepare(`SELECT ${columns.join(", ")} FROM ${table} ORDER BY rowid`).all();
  }
  return out;
}

describe("NDJSON export / restore", () => {
  let source: SqliteDatabase;
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    source = openDatabase(join(DATA_DIR, "source.db"));
  });
  afterEach(() => {
    try {
      source.close();
    } catch {
      /* already closed */
    }
  });

  it("round-trips every table and blob into a fresh database", () => {
    const repos = createRepositories(source);
    populate(repos);
    const exportPath = join(DATA_DIR, "export.ndjson");
    const exported = exportNdjson(source, exportPath);
    expect(exported.rows).toBeGreaterThan(0);
    expect(exported.blobs).toBe(1);

    // the export is self-contained: wipe the blob store and prove restore
    // brings the screenshot bytes back
    rmSync(join(DATA_DIR, "blobs"), { recursive: true, force: true });

    const target = openDatabase(join(DATA_DIR, "restored.db"));
    try {
      const restored = restoreNdjson(target, exportPath);
      expect(restored.rows).toBe(exported.rows);
      expect(dumpAll(target)).toEqual(dumpAll(source));
      // the restored database serves the screenshot back out of the blob store
      const targetRepos = createRepositories(target);
      const screen = targetRepos.messages.forThread("thread-1").find((m) => m.kind === "screen");
      expect(screen?.png).toBe(PNG_BASE64);
    } finally {
      target.close();
    }
  });

  it("rejects a tampered export before touching the target", () => {
    const repos = createRepositories(source);
    populate(repos);
    const exportPath = join(DATA_DIR, "export.ndjson");
    exportNdjson(source, exportPath);
    const lines = readFileSync(exportPath, "utf8").trimEnd().split("\n");
    const tampered = lines.map((line) => line.replace("hello", "tampered"));
    writeFileSync(exportPath, tampered.join("\n") + "\n");

    const target = openDatabase(join(DATA_DIR, "restored.db"));
    try {
      const targetRepos = createRepositories(target);
      targetRepos.snapshots.replaceMemory([{ owner: "keep-me", user: "still here", distilled: "", updatedAt: 1 }]);
      expect(() => restoreNdjson(target, exportPath)).toThrow(/checksum mismatch/);
      expect(targetRepos.snapshots.listMemory()[0]?.owner).toBe("keep-me");
    } finally {
      target.close();
    }
  });

  it("rejects a file that is not a velarixbot export", () => {
    const path = join(DATA_DIR, "bogus.ndjson");
    writeFileSync(path, JSON.stringify({ kind: "meta", format: "something-else", version: 1 }) + "\n");
    expect(() => restoreNdjson(source, path)).toThrow(/not a velarixbot export/);
  });
});
