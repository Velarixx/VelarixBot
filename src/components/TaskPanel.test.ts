import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { AgentTask } from "@/lib/agent-task";
import { TaskPanelView } from "./TaskPanel";

function task(over: Partial<AgentTask> & Pick<AgentTask, "id" | "state">): AgentTask {
  return {
    assigneeBotId: "helper",
    fromBotId: "chief",
    fromName: "Chief",
    sourceThreadId: "t-lead",
    assignment: "research this",
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

describe("TaskPanelView", () => {
  it("shows pending/active/blocked/completed and completed-versus-total counts", () => {
    const markup = renderToStaticMarkup(
      createElement(TaskPanelView, {
        tasks: [
          task({ id: "1", state: "pending" }),
          task({ id: "2", state: "active", assignment: "write the brief" }),
          task({ id: "3", state: "blocked" }),
          task({ id: "4", state: "completed" }),
        ],
      }),
    );
    expect(markup).toContain("Assigned tasks");
    expect(markup).toContain("1/4 completed");
    expect(markup).toContain("Pending");
    expect(markup).toContain("Active");
    expect(markup).toContain("Blocked");
    expect(markup).toContain("Completed");
    expect(markup).toContain("write the brief");
    expect(markup).toContain("from @Chief");
  });

  it("opening a task shows the original assignment and latest result or blocker", () => {
    const result = renderToStaticMarkup(
      createElement(TaskPanelView, {
        tasks: [task({ id: "done", state: "completed", result: "here is the research" })],
        selectedTaskId: "done",
      }),
    );
    expect(result).toContain("Original assignment");
    expect(result).toContain("research this");
    expect(result).toContain("Latest result");
    expect(result).toContain("here is the research");

    const blocked = renderToStaticMarkup(
      createElement(TaskPanelView, {
        tasks: [task({ id: "stuck", state: "blocked", blocker: "needs a password" })],
        selectedTaskId: "stuck",
      }),
    );
    expect(blocked).toContain("Latest blocker");
    expect(blocked).toContain("needs a password");
  });
});
