import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BLOCKED_STALE_AFTER_MS,
  agentTasks,
  archivedTasks,
  assigneeTurnTaskPatch,
  configureAgentTasks,
  createAgentTask,
  createMemoryAgentTasksStore,
  getAgentTask,
  isActiveQueueTask,
  listAgentTasks,
  normalizeAgentTask,
  patchAgentTask,
  reconcileStaleBlocked,
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

const structuredBlocker = {
  state: "blocked" as const,
  blocker: "needs a password",
  blockerOwner: "user",
  nextAction: "Enter the vault password",
};

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

  it("treats blocked without blocker text as stale and keeps ledger blocked+text", () => {
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
    expect(
      normalizeAgentTask({
        id: "t-text",
        assigneeBotId: "helper",
        fromBotId: "chief",
        fromName: "Chief",
        sourceThreadId: "lead-thread",
        assignment: "research this",
        state: "blocked",
        blocker: "quota",
        createdAt: 10,
        updatedAt: 10,
      })?.state,
    ).toBe("blocked");
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
    expect(agentTasks().list().filter((task) => isActiveQueueTask(task, 20))).toHaveLength(1);
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
    const active = agentTasks().list().filter((task) => isActiveQueueTask(task, 20));
    expect(active).toHaveLength(1);
    expect(active[0]?.id).toBe(next.id);
    expect(taskCounts(agentTasks().list(), 20)).toEqual({ assigned: 1, active: 1 });
  });

  it("supersedes open tasks that share a run id from a different source", () => {
    const first = seed({ assignment: "research this", runId: "run-151", now: 10 });
    const follow = seed({
      assignment: "report the result",
      sourceThreadId: "other-thread",
      fromBotId: "other",
      fromName: "Other",
      runId: "run-151",
      now: 20,
    });
    expect(follow.id).not.toBe(first.id);
    expect(agentTasks().get(first.id)?.state).toBe("superseded");
    expect(follow.state).toBe("pending");
    expect(follow.runId).toBe("run-151");
    expect(agentTasks().list().filter((task) => isActiveQueueTask(task, 20))).toHaveLength(1);
  });

  it("lets different sources keep their own active task on the same assignee", () => {
    seed({ sourceThreadId: "lead-a", assignment: "research this" });
    seed({ sourceThreadId: "lead-b", fromBotId: "other", fromName: "Other", assignment: "research this" });
    expect(agentTasks().list().filter((task) => isActiveQueueTask(task))).toHaveLength(2);
  });

  it("moves completed, cancelled, and stale out of the active queue into history", () => {
    const done = seed({ assignment: "one" });
    const cancelled = seed({ assignment: "two", sourceThreadId: "other-thread", fromBotId: "lead-2" });
    const stale = seed({ assignment: "three", sourceThreadId: "third", fromBotId: "lead-3" });
    expect(patchAgentTask(done.id, { state: "completed", result: "shipped" })?.state).toBe("completed");
    expect(patchAgentTask(cancelled.id, { state: "cancelled" })?.state).toBe("cancelled");
    expect(patchAgentTask(stale.id, { state: "stale" })?.state).toBe("stale");
    const listed = agentTasks().list();
    expect(listed.filter((task) => isActiveQueueTask(task))).toEqual([]);
    expect(archivedTasks(listed).map((task) => task.state).sort()).toEqual(["cancelled", "completed", "stale"]);
    expect(taskCounts(listed)).toEqual({ assigned: 0, active: 0 });
  });

  it("keeps structured blocked active and turns unstructured blocked into stale", () => {
    const blocked = seed({ assignment: "needs a password" });
    const empty = seed({ assignment: "no blocker", sourceThreadId: "other", fromBotId: "lead-2" });
    const textOnly = seed({ assignment: "text only", sourceThreadId: "third", fromBotId: "lead-3" });
    expect(patchAgentTask(blocked.id, structuredBlocker)?.state).toBe("blocked");
    expect(isActiveQueueTask(agentTasks().get(blocked.id)!)).toBe(true);
    expect(patchAgentTask(empty.id, { state: "blocked" })?.state).toBe("stale");
    expect(isActiveQueueTask(agentTasks().get(empty.id)!)).toBe(false);
    expect(patchAgentTask(textOnly.id, { state: "blocked", blocker: "needs a password" })?.state).toBe("stale");
    expect(isActiveQueueTask(agentTasks().get(textOnly.id)!)).toBe(false);
    expect(archivedTasks(agentTasks().list()).some((task) => task.id === empty.id)).toBe(true);
    expect(taskCounts(agentTasks().list())).toEqual({ assigned: 1, active: 1 });
  });

  it("marks an assignee turn without a structured blocker as stale at that transition", () => {
    expect(assigneeTurnTaskPatch({ ok: true, text: "here is the research" })).toEqual({
      state: "completed",
      result: "here is the research",
    });
    expect(assigneeTurnTaskPatch({ ok: false, detail: "needs a password" })).toEqual({ state: "stale" });
    expect(
      assigneeTurnTaskPatch({
        ok: false,
        detail: "needs a password",
        blockerOwner: "user",
        nextAction: "Enter the vault password",
      }),
    ).toEqual({
      state: "blocked",
      blocker: "needs a password",
      blockerOwner: "user",
      nextAction: "Enter the vault password",
    });
    expect(assigneeTurnTaskPatch({ ok: false, detail: "interrupted" })).toEqual({ state: "cancelled" });
    expect(assigneeTurnTaskPatch({ ok: true })).toEqual({ state: "stale" });
    expect(assigneeTurnTaskPatch({ ok: false })).toEqual({ state: "stale" });
  });

  it("cancels, dismisses, and marks obsolete without deleting the row", () => {
    const cancel = seed({ assignment: "one", now: 10 });
    const dismiss = seed({ assignment: "two", sourceThreadId: "t2", fromBotId: "lead-2", now: 10 });
    const obsolete = seed({ assignment: "three", sourceThreadId: "t3", fromBotId: "lead-3", now: 10 });
    expect(patchAgentTask(cancel.id, { state: "cancelled", reason: "Cancelled" }, 20)?.state).toBe("cancelled");
    expect(patchAgentTask(dismiss.id, { state: "stale", reason: "Dismissed" }, 20)?.state).toBe("stale");
    expect(patchAgentTask(obsolete.id, { state: "stale", reason: "Obsolete" }, 20)?.state).toBe("stale");
    expect(agentTasks().list()).toHaveLength(3);
    expect(agentTasks().get(cancel.id)).toMatchObject({ state: "cancelled", reason: "Cancelled", assignment: "one" });
    expect(agentTasks().get(dismiss.id)).toMatchObject({ state: "stale", reason: "Dismissed" });
    expect(agentTasks().get(obsolete.id)).toMatchObject({ state: "stale", reason: "Obsolete" });
    expect(taskCounts(agentTasks().list(), 20)).toEqual({ assigned: 0, active: 0 });
    expect(archivedTasks(agentTasks().list(), 20).map((task) => task.reason).sort()).toEqual([
      "Cancelled",
      "Dismissed",
      "Obsolete",
    ]);
  });

  it("pins BLOCKED_STALE_AFTER_MS and times out structured blocked at injected now", () => {
    expect(BLOCKED_STALE_AFTER_MS).toBe(24 * 60 * 60 * 1000);
    const clientSrc = readFileSync(join(HERE, "../src/lib/agent-task.ts"), "utf8");
    expect(clientSrc).toContain("export const BLOCKED_STALE_AFTER_MS = 24 * 60 * 60 * 1000");
    const created = seed({ assignment: "waiting", now: 1_000 });
    expect(patchAgentTask(created.id, structuredBlocker, 1_000)?.state).toBe("blocked");
    expect(isActiveQueueTask(agentTasks().get(created.id)!, 1_000 + BLOCKED_STALE_AFTER_MS)).toBe(true);
    expect(isActiveQueueTask(agentTasks().get(created.id)!, 1_000 + BLOCKED_STALE_AFTER_MS + 1)).toBe(false);
    const changed = reconcileStaleBlocked(1_000 + BLOCKED_STALE_AFTER_MS + 1);
    expect(changed).toHaveLength(1);
    expect(agentTasks().get(created.id)?.state).toBe("stale");
    expect(isActiveQueueTask(agentTasks().get(created.id)!, 1_000 + BLOCKED_STALE_AFTER_MS + 1)).toBe(false);
    expect(archivedTasks(agentTasks().list(), 1_000 + BLOCKED_STALE_AFTER_MS + 1).map((task) => task.id)).toEqual([
      created.id,
    ]);
  });

  it("evaluates stale blocked on list and read at injected now", () => {
    const created = seed({ assignment: "waiting", now: 5 });
    agentTasks().update(created.id, { ...structuredBlocker, updatedAt: 5 });
    expect(agentTasks().get(created.id)?.state).toBe("blocked");
    expect(getAgentTask(created.id, 5 + BLOCKED_STALE_AFTER_MS + 1)?.state).toBe("stale");
    const again = seed({ assignment: "other", sourceThreadId: "t2", fromBotId: "lead-2", now: 6 });
    agentTasks().update(again.id, { state: "blocked", blocker: "quota", updatedAt: 6 });
    expect(listAgentTasks(6).find((task) => task.id === again.id)?.state).toBe("stale");
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
    expect(agentTasks().list().filter((task) => isActiveQueueTask(task))).toHaveLength(0);
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
