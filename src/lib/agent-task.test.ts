import { describe, expect, it } from "vitest";
import { AGENT_TASK_STATE_LABEL, isAgentTaskState, taskCounts, tasksForBot, type AgentTask } from "./agent-task";

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
  it("counts completed versus total", () => {
    expect(
      taskCounts([
        task({ id: "1", assigneeBotId: "h", state: "completed" }),
        task({ id: "2", assigneeBotId: "h", state: "active" }),
        task({ id: "3", assigneeBotId: "h", state: "blocked" }),
      ]),
    ).toEqual({ completed: 1, total: 3 });
  });

  it("filters the persistent list to the receiving agent", () => {
    const rows = [
      task({ id: "1", assigneeBotId: "helper", state: "pending", createdAt: 2 }),
      task({ id: "2", assigneeBotId: "other", state: "active", createdAt: 1 }),
      task({ id: "3", assigneeBotId: "helper", state: "completed", createdAt: 1 }),
    ];
    expect(tasksForBot(rows, "helper").map((item) => item.id)).toEqual(["3", "1"]);
  });

  it("keeps the four task states", () => {
    for (const state of ["pending", "active", "blocked", "completed"] as const) {
      expect(isAgentTaskState(state)).toBe(true);
      expect(AGENT_TASK_STATE_LABEL[state]).toBeTruthy();
    }
    expect(isAgentTaskState("done")).toBe(false);
  });
});
