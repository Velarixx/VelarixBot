import { describe, expect, it } from "vitest";
import {
  AGENT_TASK_STATE_LABEL,
  BLOCKED_STALE_AFTER_MS,
  activeTasksForBot,
  archivedTasksForBot,
  isActiveQueueTask,
  isAgentTaskState,
  taskCounts,
  tasksForBot,
  userActionTaskPatch,
  type AgentTask,
} from "./agent-task";

function task(over: Partial<AgentTask> & Pick<AgentTask, "id" | "assigneeBotId" | "state">): AgentTask {
  return {
    fromBotId: "lead",
    fromName: "Chief",
    sourceThreadId: "t-lead",
    assignment: "research this",
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

const structured = {
  blocker: "needs a password",
  blockerOwner: "user",
  nextAction: "Enter the vault password",
};

describe("assigned tasks", () => {
  it("counts the active queue, not completed/total", () => {
    expect(
      taskCounts(
        [
          task({ id: "1", assigneeBotId: "h", state: "completed" }),
          task({ id: "2", assigneeBotId: "h", state: "active" }),
          task({ id: "3", assigneeBotId: "h", state: "blocked", ...structured }),
          task({ id: "4", assigneeBotId: "h", state: "cancelled" }),
          task({ id: "5", assigneeBotId: "h", state: "stale" }),
          task({ id: "6", assigneeBotId: "h", state: "blocked", blocker: "needs a password" }),
        ],
        1,
      ),
    ).toEqual({ assigned: 2, active: 2 });
  });

  it("filters the persistent list to the receiving agent", () => {
    const rows = [
      task({ id: "1", assigneeBotId: "helper", state: "pending", createdAt: 2 }),
      task({ id: "2", assigneeBotId: "other", state: "active", createdAt: 1 }),
      task({ id: "3", assigneeBotId: "helper", state: "completed", createdAt: 1 }),
    ];
    expect(tasksForBot(rows, "helper").map((item) => item.id)).toEqual(["3", "1"]);
    expect(activeTasksForBot(rows, "helper").map((item) => item.id)).toEqual(["1"]);
    expect(archivedTasksForBot(rows, "helper").map((item) => item.id)).toEqual(["3"]);
  });

  it("keeps active and archive states and requires a structured blocker", () => {
    for (const state of [
      "pending",
      "active",
      "blocked",
      "completed",
      "cancelled",
      "superseded",
      "stale",
    ] as const) {
      expect(isAgentTaskState(state)).toBe(true);
      expect(AGENT_TASK_STATE_LABEL[state]).toBeTruthy();
    }
    expect(isAgentTaskState("done")).toBe(false);
    expect(isActiveQueueTask(task({ id: "b", assigneeBotId: "h", state: "blocked", ...structured }), 1)).toBe(true);
    expect(isActiveQueueTask(task({ id: "s", assigneeBotId: "h", state: "blocked" }), 1)).toBe(false);
    expect(
      isActiveQueueTask(task({ id: "t", assigneeBotId: "h", state: "blocked", blocker: "need input" }), 1),
    ).toBe(false);
  });

  it("pins BLOCKED_STALE_AFTER_MS and treats timed-out blocked as history", () => {
    expect(BLOCKED_STALE_AFTER_MS).toBe(24 * 60 * 60 * 1000);
    const row = task({
      id: "old",
      assigneeBotId: "h",
      state: "blocked",
      ...structured,
      updatedAt: 10,
    });
    expect(isActiveQueueTask(row, 10 + BLOCKED_STALE_AFTER_MS)).toBe(true);
    expect(isActiveQueueTask(row, 10 + BLOCKED_STALE_AFTER_MS + 1)).toBe(false);
    expect(taskCounts([row], 10 + BLOCKED_STALE_AFTER_MS + 1)).toEqual({ assigned: 0, active: 0 });
  });

  it("maps user archive actions to terminal patches", () => {
    expect(userActionTaskPatch("cancel")).toEqual({ state: "cancelled", reason: "Cancelled" });
    expect(userActionTaskPatch("dismiss")).toEqual({ state: "stale", reason: "Dismissed" });
    expect(userActionTaskPatch("obsolete")).toEqual({ state: "stale", reason: "Obsolete" });
  });
});
