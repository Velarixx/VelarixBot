// P1.7 acceptance, pinned:
//   1. the export contains NO transcripts by default (canary text in
//      messages and event payloads must never appear in the bundle);
//   2. secrets stay redacted (provider reasons, audit matchers, and config
//      keys — which the bundle must not read at all);
//   3. the bundle carries versions, capabilities, redacted logs, and an
//      integrity result;
//   4. backupNow produces the verified snapshot under ~/.velarixbot/backup.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { appendAudit } from "../approvals.ts";
import { DATA_DIR, saveConfig } from "../config.ts";
import { manifestPathFor, restoreBackupIntoEmptyProfile } from "../db/backup.ts";
import { defaultDbPath, openDatabase } from "../db/database.ts";
import type { SqliteDatabase } from "../db/sqlite-native.ts";
import { createRepositories, type Repositories } from "../repositories/index.ts";
import { createDiagnosticsService, redactDeep, type DiagnosticsService } from "./diagnostics.ts";

const TRANSCRIPT_CANARY = "TRANSCRIPT-CANARY-must-never-export";
const REASON_SECRET = "Bearer fake-bearer-abc123";
const AUDIT_SECRET = "token=fake-audit-hunter2";
const CONFIG_SECRET = "xai-fakeconfigkey123";

const providers = {
  describe: async () => [
    {
      instanceId: "claude",
      driverKind: "claudeAgent",
      displayName: "Claude",
      snapshot: { state: "available", version: "2.1.0" },
      models: { default: "claude-sonnet-5", options: [{ id: "claude-sonnet-5", label: "Sonnet" }] },
    },
    {
      instanceId: "grok",
      driverKind: "grokAgent",
      displayName: "Grok",
      snapshot: { state: "unavailable", reason: `CLI probe failed sending ${REASON_SECRET}` },
      models: { default: "", options: [] },
    },
  ],
};

const computers = {
  list: () => [
    {
      id: "local",
      kind: "local",
      displayName: "This computer",
      capabilities: { exec: true, screenshot: true, files: true, desktopUrl: false, suspend: false, destroy: false, mcp: false },
    },
  ],
};

describe("diagnostics export (P1.7)", () => {
  let db: SqliteDatabase;
  let repos: Repositories;
  let diagnostics: DiagnosticsService;

  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    db = openDatabase(defaultDbPath());
    repos = createRepositories(db);
    diagnostics = createDiagnosticsService({ repos, providers, computers, stamp: "test-stamp", now: () => 1_700_000_000_000 });

    // transcript + secret material that must NOT surface in the bundle
    repos.bots.insert({
      id: "bot-1",
      threadId: "thread-1",
      name: "Diag",
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
    repos.messages.append("thread-1", { role: "user", kind: "text", text: TRANSCRIPT_CANARY });
    repos.eventLog.append({
      eventId: "ev-1",
      provider: "claudeAgent",
      threadId: "thread-1",
      createdAt: "2026-01-01T00:00:00Z",
      type: "turn.completed",
      text: TRANSCRIPT_CANARY,
    } as never);
    appendAudit({ bot: "bot-1", tool: "Bash", matcher: `curl -H '${AUDIT_SECRET}'`, decision: "user.allow" });
    saveConfig({ xai: { key: CONFIG_SECRET } });
  });
  afterEach(() => {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  });

  it("carries versions, capabilities, redacted logs, and an integrity result", async () => {
    const bundle = await diagnostics.exportBundle();

    expect(bundle.format).toBe("velarixbot-diagnostics");
    expect(bundle.versions.app).toMatch(/^\d+\.\d+\.\d+/); // repo package.json in dev/CI
    expect(bundle.versions.node).toBe(process.version);
    expect(bundle.versions.platform).toBe(process.platform);
    expect(bundle.versions.schemaVersion).toBeGreaterThanOrEqual(3);
    expect(bundle.versions.stamp).toBe("test-stamp");

    expect(bundle.capabilities.providers).toEqual([
      expect.objectContaining({ instanceId: "claude", state: "available", version: "2.1.0", defaultModel: "claude-sonnet-5", models: ["claude-sonnet-5"] }),
      expect.objectContaining({ instanceId: "grok", state: "unavailable" }),
    ]);
    expect(bundle.capabilities.computers).toEqual([
      expect.objectContaining({ id: "local", kind: "local", capabilities: expect.objectContaining({ exec: true, mcp: false }) }),
    ]);

    expect(bundle.integrity.result).toBe("ok");
    expect(bundle.integrity.tables.messages).toBe(1); // counts only, never content

    expect(bundle.logs.events.length).toBe(1);
    expect(bundle.logs.events[0]).toMatchObject({ eventId: "ev-1", type: "turn.completed", threadId: "thread-1" });
    expect(bundle.logs.eventsTotal).toBe(1);
    expect(bundle.logs.approvalAudit.length).toBe(1);
    expect(bundle.logs.approvalAudit[0]).toMatchObject({ bot: "bot-1", tool: "Bash", decision: "user.allow" });
  });

  it("contains no transcripts by default — canary text in messages and event payloads never exports", async () => {
    const bundle = await diagnostics.exportBundle();
    const serialized = JSON.stringify(bundle);
    expect(bundle.transcriptsIncluded).toBe(false);
    expect(serialized).not.toContain(TRANSCRIPT_CANARY);
    // event entries are metadata-only: no payload-bearing fields at all
    for (const entry of bundle.logs.events) {
      expect(Object.keys(entry).sort()).toEqual(["createdAt", "eventId", "seq", "sequence", "streamId", "threadId", "type"]);
    }
  });

  it("keeps secrets redacted: provider reasons, audit matchers, and config keys", async () => {
    const bundle = await diagnostics.exportBundle();
    const serialized = JSON.stringify(bundle);
    expect(serialized).not.toContain(REASON_SECRET);
    expect(serialized).not.toContain(AUDIT_SECRET.split("=")[1]); // the value after token=
    expect(serialized).not.toContain(CONFIG_SECRET); // config.json is never read at all
    expect(serialized).toContain("[redacted]"); // proof redaction ran, not that fixtures were absent
  });

  it("redactDeep scrubs strings at every depth without breaking structure", () => {
    const scrubbed = redactDeep({
      a: "Bearer fake-deep-bearer",
      b: [{ c: "api_key: fake-deep-value" }, 7, null],
      d: true,
    });
    expect(scrubbed.a).toBe("Bearer [redacted]");
    expect((scrubbed.b[0] as { c: string }).c).toContain("[redacted]");
    expect(scrubbed.b[1]).toBe(7);
    expect(scrubbed.d).toBe(true);
  });

  it("backupNow writes the verified snapshot under the profile's backup dir — and it restores", () => {
    const { path, manifest } = diagnostics.backupNow();
    expect(path.startsWith(join(DATA_DIR, "backup"))).toBe(true);
    expect(existsSync(path)).toBe(true);
    expect(manifest.integrity).toBe("ok");
    expect(manifest.tables.messages).toBe(1);
    expect(JSON.parse(readFileSync(manifestPathFor(path), "utf8")).sha256).toBe(manifest.sha256);

    // same-millisecond fake clock: a second click still gets a unique name
    const second = diagnostics.backupNow();
    expect(second.path).not.toBe(path);

    // the one-click archive restores into an empty profile
    const outcome = restoreBackupIntoEmptyProfile(path, join(DATA_DIR, "restored-profile", "velarixbot.db"));
    expect(outcome.tables).toEqual(manifest.tables);
  });
});
