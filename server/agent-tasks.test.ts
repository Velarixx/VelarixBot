import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  agentTasks,
  archivedTasks,
  assigneeTurnTaskPatch,
  configureAgentTasks,
  createAgentTask,
  createMemoryAgentTasksStore,
  isActiveQueueTask,
  normalizeAgentTask,
  patchAgentTask,
  taskCounts,
} from "./agent-tasks.ts";
import { DATA_DIR } from "./config.ts";
import { defaultDbPath, openDatabase } from "./db/database.ts";
import type { SqliteDatabase } from "./db/sqlite-native.ts";
import { createRepositories } from "./repositories/index.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

function seed(over: Partial<Parameters<typeof createAgentTask>[0]> = {}) {
  return createAgentTask({
    assigneeBotId: "helper",
    fromBotId: "chief",
    fromName: "Chief",
    sourceThreadId: "lead-thread",
    assignment: "research this",
    ...over,
  });
}

describe("normalizeAgentTask", () => {
  it("drops unrecognizable rows and keeps active plus archive states", () => {
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
    for (const state of ["cancelled", "superseded", "stale"] as const) {
      expect(
        normalizeAgentTask({
          id: state,
          assigneeBotId: "helper",
          fromBotId: "chief",
          fromName: "Chief",
          sourceThreadId: "lead-thread",
          assignment: "research this",
          state,
          createdAt: 10,
          updatedAt: 10,
        })?.state,
      ).toBe(state);
    }
  });

  it("treats blocked without blocker text as stale", () => {
    expect(
      normalizeAgentTask({
        id: "t-empty",
        assigneeBotId: "helper",
        fromBotId: "chief",
        fromName: "Chief",
        sourceThreadId: "lead-thread",
        assignment: "research this",
        state: "blocked",
        createdAt: 10,
        updatedAt: 10,
      })?.state,
    ).toBe("stale");
  });
});

describe("assigned-task queue hygiene", () => {
  beforeEach(() => {
    configureAgentTasks(createMemoryAgentTasksStore());
  });

  afterEach(() => {
    configureAgentTasks(null);
  });

  it("inserts the same assignment twice as one active row and refreshes the existing one", () => {
    const first = seed({ assignmentMessageId: "m1", now: 10 });
    const second = seed({ assignment: "  research   this  ", assignmentMessageId: "m2", now: 20 });
    expect(second.id).toBe(first.id);
    expect(agentTasks().list()).toHaveLength(1);
    expect(agentTasks().list().filter(isActiveQueueTask)).toHaveLength(1);
    expect(second.updatedAt).toBe(20);
    expect(second.assignmentMessageId).toBe("m2");
    expect(second.state).toBe("pending");
  });

  it("supersedes the previous open row when the same source sends a new assignment", () => {
    const first = seed({ assignment: "research this", now: 10 });
    const next = seed({ assignment: "write the brief", now: 20 });
    expect(next.id).not.toBe(first.id);
    expect(next.state).toBe("pending");
    expect(agentTasks().get(first.id)?.state).toBe("superseded");
    const active = agentTasks().list().filter(isActiveQueueTask);
    expect(active).toHaveLength(1);
    expect(active[0]?.id).toBe(next.id);
    expect(taskCounts(agentTasks().list())).toEqual({ assigned: 1, active: 1 });
  });

  it("lets different sources keep their own active task on the same assignee", () => {
    seed({ sourceThreadId: "lead-a", assignment: "research this" });
    seed({ sourceThreadId: "lead-b", fromBotId: "other", fromName: "Other", assignment: "research this" });
    expect(agentTasks().list().filter(isActiveQueueTask)).toHaveLength(2);
  });

  it("moves completed, cancelled, and stale out of the active queue into history", () => {
    const done = seed({ assignment: "one" });
    const cancelled = seed({ assignment: "two", sourceThreadId: "other-thread", fromBotId: "lead-2" });
    const stale = seed({ assignment: "three", sourceThreadId: "third", fromBotId: "lead-3" });
    expect(patchAgentTask(done.id, { state: "completed", result: "shipped" })?.state).toBe("completed");
    expect(patchAgentTask(cancelled.id, { state: "cancelled" })?.state).toBe("cancelled");
    expect(patchAgentTask(stale.id, { state: "stale" })?.state).toBe("stale");
    const listed = agentTasks().list();
    expect(listed.filter(isActiveQueueTask)).toEqual([]);
    expect(archivedTasks(listed).map((task) => task.state).sort()).toEqual(["cancelled", "completed", "stale"]);
    expect(taskCounts(listed)).toEqual({ assigned: 0, active: 0 });
  });

  it("keeps blocked-with-blocker active and turns blocked-without-blocker into stale", () => {
    const blocked = seed({ assignment: "needs a password" });
    const empty = seed({ assignment: "no blocker", sourceThreadId: "other", fromBotId: "lead-2" });
    expect(patchAgentTask(blocked.id, { state: "blocked", blocker: "needs a password" })?.state).toBe("blocked");
    expect(isActiveQueueTask(agentTasks().get(blocked.id)!)).toBe(true);
    expect(patchAgentTask(empty.id, { state: "blocked" })?.state).toBe("stale");
    expect(isActiveQueueTask(agentTasks().get(empty.id)!)).toBe(false);
    expect(archivedTasks(agentTasks().list()).some((task) => task.id === empty.id)).toBe(true);
    expect(taskCounts(agentTasks().list())).toEqual({ assigned: 1, active: 1 });
  });

  it("marks an assignee turn without result or blocker as stale at that transition", () => {
    expect(assigneeTurnTaskPatch({ ok: true, text: "here is the research" })).toEqual({
      state: "completed",
      result: "here is the research",
    });
    expect(assigneeTurnTaskPatch({ ok: false, detail: "needs a password" })).toEqual({
      state: "blocked",
      blocker: "needs a password",
    });
    expect(assigneeTurnTaskPatch({ ok: false, detail: "interrupted" })).toEqual({ state: "cancelled" });
    expect(assigneeTurnTaskPatch({ ok: true })).toEqual({ state: "stale" });
    expect(assigneeTurnTaskPatch({ ok: false })).toEqual({ state: "stale" });
  });

  it("does not implement stale with a timer", () => {
    const src = readFileSync(join(HERE, "agent-tasks.ts"), "utf8");
    expect(src).not.toMatch(/setTimeout|setInterval|sleep\(/);
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

  it("reloads cancelled, superseded, and stale history rows without deleting them", () => {
    const cancelled = seed({ assignment: "one" });
    const superseded = seed({ assignment: "two", sourceThreadId: "t2", fromBotId: "lead-2" });
    const stale = seed({ assignment: "three", sourceThreadId: "t3", fromBotId: "lead-3" });
    patchAgentTask(cancelled.id, { state: "cancelled" });
    patchAgentTask(superseded.id, { state: "superseded" });
    patchAgentTask(stale.id, { state: "stale" });

    db.close();
    db = openDatabase(defaultDbPath());
    configureAgentTasks(createRepositories(db).agentTasks);
    expect(agentTasks().get(cancelled.id)?.state).toBe("cancelled");
    expect(agentTasks().get(superseded.id)?.state).toBe("superseded");
    expect(agentTasks().get(stale.id)?.state).toBe("stale");
    expect(agentTasks().list()).toHaveLength(3);
    expect(agentTasks().list().filter(isActiveQueueTask)).toHaveLength(0);
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
