import { describe, expect, it } from "vitest";
import {
  AGENT_TASK_STATE_LABEL,
  activeTasksForBot,
  archivedTasksForBot,
  isActiveQueueTask,
  isAgentTaskState,
  taskCounts,
  tasksForBot,
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

describe("assigned tasks", () => {
  it("counts the active queue, not completed/total", () => {
    expect(
      taskCounts([
        task({ id: "1", assigneeBotId: "h", state: "completed" }),
        task({ id: "2", assigneeBotId: "h", state: "active" }),
        task({ id: "3", assigneeBotId: "h", state: "blocked", blocker: "needs a password" }),
        task({ id: "4", assigneeBotId: "h", state: "cancelled" }),
        task({ id: "5", assigneeBotId: "h", state: "stale" }),
      ]),
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

  it("keeps active and archive states", () => {
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
    expect(isActiveQueueTask(task({ id: "b", assigneeBotId: "h", state: "blocked", blocker: "need input" }))).toBe(true);
    expect(isActiveQueueTask(task({ id: "s", assigneeBotId: "h", state: "blocked" }))).toBe(false);
  });
});
