// Transactional importer: backup first, ids/timestamps preserved, checksum
// verified, rerunnable, originals untouched — and a mid-transaction failure
// leaves the database empty.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR, EVENTS_DIR } from "../config.ts";
import { createRepositories, type Repositories } from "../repositories/index.ts";
import { defaultDbPath, openDatabase } from "./database.ts";
import { IMPORT_MIGRATION_NAME, importLegacyData, refreshSnapshots } from "./importer.ts";
import { isApplied } from "./migrations.ts";
import type { SqliteDatabase } from "./sqlite-native.ts";

const PNG_BASE64 = Buffer.from("screenshot-bytes").toString("base64");
const THREAD_A = "thread-aaaa";
const THREAD_B = "thread-bbbb";

const botA = {
  id: "bot-a",
  threadId: THREAD_A,
  name: "Alpha",
  title: "First",
  description: "",
  notifications: true,
  color: "blue",
  iconShape: "cursor",
  unread: false,
  modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
  resumeCursors: { claude: "sess-1" },
  computer: "off",
  busy: false,
  state: "IDLE",
  usage: { input: 3, output: 4, cost: null },
  createdAt: 1_700_000_000_000,
};
const botB = { ...botA, id: "bot-b", threadId: THREAD_B, name: "Beta", createdAt: 1_700_000_100_000 };

function writeLegacyTree(): void {
  mkdirSync(DATA_DIR, { recursive: true });
  // bots.json is newest-first on disk (the old unshift order)
  writeFileSync(join(DATA_DIR, "bots.json"), JSON.stringify([botB, botA]));
  writeFileSync(
    join(DATA_DIR, `messages-${THREAD_A}.json`),
    JSON.stringify([
      { id: "m1", role: "user", kind: "text", text: "hello", at: 1_700_000_000_001 },
      { id: "m2", role: "bot", kind: "screen", png: PNG_BASE64, mime: "image/png", at: 1_700_000_000_002 },
    ]),
  );
  writeFileSync(
    join(DATA_DIR, `messages-${THREAD_B}.json`),
    JSON.stringify([{ id: "m3", role: "bot", kind: "text", text: "hi from beta", at: 1_700_000_100_001 }]),
  );
  writeFileSync(
    join(DATA_DIR, "routines.json"),
    JSON.stringify([
      {
        id: "routine-1",
        botId: "bot-a",
        name: "Morning",
        prompt: "Brief me",
        schedule: { kind: "daily", time: "09:30" },
        enabled: true,
        running: false,
        nextRunAt: 1_700_000_200_000,
        lastRunAt: 1_699_999_000_000,
        lastResult: "DONE",
        createdAt: 1_699_990_000_000,
      },
    ]),
  );
  writeFileSync(
    join(DATA_DIR, "skills.json"),
    JSON.stringify([{ id: "skill-1", name: "File a report", botId: "bot-a", markdown: "# Steps\n1. Do it\n", createdAt: 1_699_980_000_000 }]),
  );
  mkdirSync(join(DATA_DIR, "approvals"), { recursive: true });
  writeFileSync(
    join(DATA_DIR, "approvals", "bot-a.json"),
    JSON.stringify([{ id: "rule-1", tool: "Bash", pattern: "git status", action: "allow", createdAt: 5, confirmed: true }]),
  );
  writeFileSync(
    join(DATA_DIR, "approvals", "audit.jsonl"),
    JSON.stringify({ at: 6, bot: "bot-a", tool: "Bash", matcher: "git status", decision: "user.allow", ruleId: "rule-1" }) + "\n",
  );
  mkdirSync(join(DATA_DIR, "memory"), { recursive: true });
  writeFileSync(join(DATA_DIR, "memory", "workspace.md"), "Team ships on Fridays.\n");
  writeFileSync(join(DATA_DIR, "memory", "bot-a.md"), "Call me Sam.\n");
  mkdirSync(EVENTS_DIR, { recursive: true });
  writeFileSync(
    join(EVENTS_DIR, `${THREAD_A}.ndjson`),
    [
      JSON.stringify({ eventId: "ev-1", provider: "claudeAgent", threadId: THREAD_A, createdAt: "2026-01-01T00:00:00Z", type: "turn.started" }),
      JSON.stringify({ eventId: "ev-2", provider: "claudeAgent", threadId: THREAD_A, createdAt: "2026-01-01T00:00:01Z", type: "turn.completed", ok: true }),
      '{"torn', // a crash can leave a torn trailing line — must not break the import
    ].join("\n"),
  );
}

function treeChecksums(): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string, rel: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "velarixbot.db" || entry.name.startsWith("velarixbot.db-")) continue;
      if (entry.name === "backup" || entry.name === "blobs") continue;
      const abs = join(dir, entry.name);
      const key = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(abs, key);
      else out.set(key, createHash("sha256").update(readFileSync(abs)).digest("hex"));
    }
  };
  walk(DATA_DIR, "");
  return out;
}

describe("legacy JSON importer", () => {
  let db: SqliteDatabase;
  let repos: Repositories;
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    writeLegacyTree();
    db = openDatabase(defaultDbPath());
    repos = createRepositories(db);
  });
  afterEach(() => {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  });

  it("imports everything, preserving ids, timestamps, and order", () => {
    const before = treeChecksums();
    const result = importLegacyData(repos, { now: 1_700_000_300_000, backupStamp: "test-backup" });
    expect(result.imported).toBe(true);
    expect(result.counts).toEqual({
      bots: 2,
      routines: 1,
      messages: 3,
      events: 2,
      approvalRules: 1,
      approvalAudit: 1,
      skills: 1,
      memory: 2,
    });
    expect(result.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(isApplied(db, IMPORT_MIGRATION_NAME)).toBe(true);

    // sidebar order and identity preserved
    expect(repos.bots.list().map((b) => b.id)).toEqual(["bot-b", "bot-a"]);
    expect(repos.bots.get("bot-a")).toMatchObject({ createdAt: botA.createdAt, resumeCursors: { claude: "sess-1" } });
    const messagesA = repos.messages.forThread(THREAD_A);
    expect(messagesA.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(messagesA[0].at).toBe(1_700_000_000_001);
    expect(messagesA[1].png).toBe(PNG_BASE64);
    expect(repos.routines.get("routine-1")).toMatchObject({ lastRunAt: 1_699_999_000_000, createdAt: 1_699_990_000_000 });
    expect(repos.eventLog.forThread(THREAD_A).map((e) => e.eventId)).toEqual(["ev-1", "ev-2"]);
    expect(repos.snapshots.listApprovalRules()).toEqual([
      { scope: "bot-a", rule: { id: "rule-1", tool: "Bash", pattern: "git status", action: "allow", createdAt: 5, confirmed: true } },
    ]);
    expect(repos.snapshots.listApprovalAudit()[0]).toMatchObject({ decision: "user.allow", ruleId: "rule-1" });
    expect(repos.snapshots.listSkills()[0]).toMatchObject({ id: "skill-1", createdAt: 1_699_980_000_000 });
    expect(repos.snapshots.listMemory().map((m) => m.owner).sort()).toEqual(["_workspace", "bot-a"]);

    // blob left the JSON: the png bytes are on disk, not in SQLite
    const row = db.prepare<{ png_hash: string | null; data: string }>("SELECT png_hash, data FROM messages WHERE id = 'm2'").get()!;
    expect(row.png_hash).toBeTruthy();
    expect(row.data).not.toContain(PNG_BASE64);

    // originals untouched, byte for byte
    expect(treeChecksums()).toEqual(before);

    // backup dir carries byte-identical copies of every source
    const backupRoot = join(DATA_DIR, "backup", "test-backup");
    expect(result.backupDir).toBe(backupRoot);
    for (const rel of ["bots.json", "routines.json", `messages-${THREAD_A}.json`, "skills.json", join("approvals", "bot-a.json"), join("memory", "workspace.md"), join("events", `${THREAD_A}.ndjson`)]) {
      expect(readFileSync(join(backupRoot, rel))).toEqual(readFileSync(join(DATA_DIR, rel)));
    }
  });

  it("is rerunnable: the second run is a no-op that duplicates nothing", () => {
    importLegacyData(repos, { now: 1, backupStamp: "b1" });
    const again = importLegacyData(repos, { now: 2, backupStamp: "b2" });
    expect(again).toMatchObject({ imported: false, skipped: "already-imported" });
    expect(repos.bots.count()).toBe(2);
    expect(repos.messages.countForThread(THREAD_A)).toBe(2);
    expect(existsSync(join(DATA_DIR, "backup", "b2"))).toBe(false);
  });

  it("rolls the whole import back when anything fails mid-transaction", () => {
    db.exec("CREATE TRIGGER fail_skills BEFORE INSERT ON skills BEGIN SELECT RAISE(ABORT, 'injected'); END;");
    expect(() => importLegacyData(repos, { now: 1, backupStamp: "b-fail" })).toThrow(/injected/);
    expect(repos.bots.count()).toBe(0);
    expect(repos.messages.countForThread(THREAD_A)).toBe(0);
    expect(repos.routines.list()).toEqual([]);
    expect(isApplied(db, IMPORT_MIGRATION_NAME)).toBe(false);
    // originals still untouched; a later run (bug fixed) succeeds
    db.exec("DROP TRIGGER fail_skills;");
    expect(importLegacyData(repos, { now: 2, backupStamp: "b-retry" }).imported).toBe(true);
  });

  it("never clobbers a database that already has live rows", () => {
    repos.bots.insert({ ...botA, id: "live-bot", threadId: "live-thread" } as never);
    const result = importLegacyData(repos, { now: 1, backupStamp: "b-live" });
    expect(result).toMatchObject({ imported: false, skipped: "database-not-empty" });
    expect(repos.bots.count()).toBe(1);
    expect(isApplied(db, IMPORT_MIGRATION_NAME)).toBe(true);
  });

  it("refreshSnapshots keeps file-authoritative domains current on every boot", () => {
    importLegacyData(repos, { now: 1, backupStamp: "b1" });
    // the file modules stay the runtime authority; a later boot re-syncs
    writeFileSync(
      join(DATA_DIR, "skills.json"),
      JSON.stringify([{ id: "skill-2", name: "New skill", botId: "bot-b", markdown: "# New\n1. Step\n", createdAt: 7 }]),
    );
    refreshSnapshots(repos, 2);
    expect(repos.snapshots.listSkills().map((s) => s.id)).toEqual(["skill-2"]);
  });
});
