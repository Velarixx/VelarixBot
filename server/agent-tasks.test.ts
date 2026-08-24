import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";

import {
  agentTasks,
  configureAgentTasks,
  createAgentTask,
  createMemoryAgentTasksStore,
  normalizeAgentTask,
  patchAgentTask,
} from "./agent-tasks.ts";
import { DATA_DIR } from "./config.ts";
import { defaultDbPath, openDatabase } from "./db/database.ts";
import type { SqliteDatabase } from "./db/sqlite-native.ts";
import { createRepositories } from "./repositories/index.ts";

describe("normalizeAgentTask", () => {
  it("drops unrecognizable rows and keeps the four states", () => {
    expect(normalizeAgentTask(null)).toBeNull();
    expect(normalizeAgentTask({ id: "t", assigneeBotId: "a" })).toBeNull();
    const row = normalizeAgentTask({
      id: "t1",
      assigneeBotId: "helper",
      fromBotId: "chief",
      fromName: "Chief",
      sourceThreadId: "lead-thread",
      assignment: "research this",
      state: "pending",
      createdAt: 10,
      updatedAt: 10,
    });
    expect(row).toMatchObject({ id: "t1", state: "pending", assignment: "research this" });
  });
});

describe("agent task persist / reload", () => {
  let db: SqliteDatabase;

  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    db = openDatabase(defaultDbPath());
    configureAgentTasks(createRepositories(db).agentTasks);
  });

  afterEach(() => {
    configureAgentTasks(null);
    try {
      db.close();
    } catch {
      /* already closed */
    }
  });

  it("survives a close/reopen with state updates", () => {
    const created = createAgentTask({
      assigneeBotId: "helper",
      fromBotId: "chief",
      fromName: "Chief",
      sourceThreadId: "lead-thread",
      assignment: "research this",
      reason: "next step",
    });
    expect(created.state).toBe("pending");
    expect(patchAgentTask(created.id, { state: "active" })?.state).toBe("active");
    expect(patchAgentTask(created.id, { state: "completed", result: "done" })?.result).toBe("done");

    db.close();
    db = openDatabase(defaultDbPath());
    configureAgentTasks(createRepositories(db).agentTasks);
    const reloaded = agentTasks().get(created.id);
    expect(reloaded).toMatchObject({
      id: created.id,
      assignment: "research this",
      reason: "next step",
      state: "completed",
      result: "done",
    });
  });

  it("memory fallback is isolated when the store is reset", () => {
    configureAgentTasks(createMemoryAgentTasksStore());
    createAgentTask({
      assigneeBotId: "helper",
      fromBotId: "chief",
      fromName: "Chief",
      sourceThreadId: "lead-thread",
      assignment: "one",
    });
    expect(agentTasks().list()).toHaveLength(1);
    configureAgentTasks(null);
    expect(agentTasks().list()).toHaveLength(0);
  });
});
