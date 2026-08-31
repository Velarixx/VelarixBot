import { createElement } from "react";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import type { AgentTask } from "@/lib/agent-task";
import { resetTaskPanelPrefsForTests, writeTaskPanelPref } from "@/lib/task-panel-prefs";
import { StoreProvider, type Message } from "@/state/store";
import { OptionCard } from "./OptionCard";
import { TaskPanelView } from "./TaskPanel";

const HERE = dirname(fileURLToPath(import.meta.url));

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

const structuredBlocked = {
  blocker: "needs a password",
  blockerOwner: "user",
  nextAction: "Enter the vault password",
};

const needsInputMessage: Message = {
  id: "message-1",
  role: "bot",
  kind: "options",
  at: 1,
  card: {
    title: "Approval needed",
    subtitle: "Run the requested tool?",
    options: ["Allow once", "Deny"],
    requestId: "request-1",
    requestType: "permission",
  },
};

describe("TaskPanelView", () => {
  afterEach(() => {
    resetTaskPanelPrefsForTests();
  });

  it("lists only the active queue and shows an active header count", () => {
    const markup = renderToStaticMarkup(
      createElement(TaskPanelView, {
        now: 1,
        tasks: [
          task({ id: "1", state: "pending" }),
          task({ id: "2", state: "active", assignment: "write the brief" }),
          task({ id: "3", state: "blocked", ...structuredBlocked }),
          task({ id: "4", state: "completed" }),
          task({ id: "5", state: "cancelled" }),
          task({ id: "6", state: "superseded" }),
          task({ id: "7", state: "stale" }),
        ],
      }),
    );
    expect(markup).toContain("Assigned tasks");
    expect(markup).toContain("3 assigned / 3 active");
    expect(markup).not.toContain("completed");
    expect(markup).toContain("Pending");
    expect(markup).toContain("Active");
    expect(markup).toContain("Blocked");
    expect(markup).toContain("write the brief");
    expect(markup).toContain("from @Chief");
    expect(markup).not.toContain("Completed");
    expect(markup).not.toContain("Cancelled");
    expect(markup).not.toContain("Superseded");
    expect(markup).not.toContain("Stale");
  });

  it("keeps archived rows in history with assignment and result or blocker detail", () => {
    const result = renderToStaticMarkup(
      createElement(TaskPanelView, {
        tasks: [task({ id: "done", state: "completed", result: "here is the research" })],
        selectedTaskId: "done",
        historyOpen: true,
      }),
    );
    expect(result).toContain("History");
    expect(result).toContain("Completed");
    expect(result).toContain("Original assignment");
    expect(result).toContain("research this");
    expect(result).toContain("Latest result");
    expect(result).toContain("here is the research");

    const blocked = renderToStaticMarkup(
      createElement(TaskPanelView, {
        now: 1,
        tasks: [task({ id: "stuck", state: "blocked", ...structuredBlocked })],
        selectedTaskId: "stuck",
      }),
    );
    expect(blocked).toContain("Latest blocker");
    expect(blocked).toContain("needs a password");
    expect(blocked).toContain("Owner / dependency: user");
    expect(blocked).toContain("Next action: Enter the vault password");
    expect(blocked).toContain("Updated");
    expect(blocked).toContain("1 assigned / 1 active");
  });

  it("keeps unstructured blocked and terminal rows in history, not the active count", () => {
    const markup = renderToStaticMarkup(
      createElement(TaskPanelView, {
        now: 1,
        tasks: [
          task({ id: "text-only", state: "blocked", blocker: "needs a password" }),
          task({ id: "done", state: "completed", result: "here is the research" }),
        ],
        historyOpen: true,
        selectedTaskId: "text-only",
      }),
    );
    expect(markup).toContain("0 assigned / 0 active");
    expect(markup).toContain("History");
    expect(markup).toContain("Blocked");
    expect(markup).toContain("Completed");
  });

  it("exposes cancel, dismiss, and obsolete on an active task without rewriting hide", () => {
    const markup = renderToStaticMarkup(
      createElement(TaskPanelView, {
        tasks: [task({ id: "1", state: "pending" })],
        selectedTaskId: "1",
        onTaskAction: () => {},
      }),
    );
    expect(markup).toContain("Cancel");
    expect(markup).toContain("Dismiss / archive");
    expect(markup).toContain("Mark obsolete");
    const hidden = renderToStaticMarkup(
      createElement(TaskPanelView, {
        tasks: [task({ id: "1", state: "pending" })],
        visibility: "hidden",
        onTaskAction: () => {},
      }),
    );
    expect(hidden).toContain("Restore assigned tasks");
    expect(hidden).not.toContain("Cancel");
  });

  it("projects delivery status without rewriting hide or collapse", () => {
    const markup = renderToStaticMarkup(
      createElement(TaskPanelView, {
        tasks: [
          task({
            id: "1",
            state: "completed",
            deliveryState: "delivered",
            result: "here is the research",
          }),
        ],
        historyOpen: true,
        selectedTaskId: "1",
      }),
    );
    expect(markup).toContain("delivered");
    expect(markup).toContain("History");
    const hidden = renderToStaticMarkup(
      createElement(TaskPanelView, {
        tasks: [task({ id: "1", state: "pending", deliveryState: "delivery_pending" })],
        visibility: "hidden",
      }),
    );
    expect(hidden).toContain("Restore assigned tasks");
    expect(hidden).not.toContain("delivery pending");
  });

  it("collapses the list while keeping the header and count", () => {
    const markup = renderToStaticMarkup(
      createElement(TaskPanelView, {
        tasks: [task({ id: "1", state: "pending", assignment: "write the brief" })],
        visibility: "collapsed",
      }),
    );
    expect(markup).toContain("Assigned tasks");
    expect(markup).toContain("1 assigned / 1 active");
    expect(markup).not.toContain("write the brief");
    expect(markup).toContain("Expand");
  });

  it("hides the section and leaves a restore control that can open history", () => {
    const hiddenActive = renderToStaticMarkup(
      createElement(TaskPanelView, {
        tasks: [task({ id: "1", state: "pending" })],
        visibility: "hidden",
      }),
    );
    expect(hiddenActive).toContain("Assigned tasks (1)");
    expect(hiddenActive).not.toContain("Pending");
    expect(hiddenActive).not.toContain("1 assigned / 1 active");

    const hiddenHistory = renderToStaticMarkup(
      createElement(TaskPanelView, {
        tasks: [task({ id: "1", state: "completed" })],
        visibility: "hidden",
        historyOpen: true,
      }),
    );
    expect(hiddenHistory).toContain("Assigned tasks");
    expect(hiddenHistory).toContain("History");
    expect(hiddenHistory).toContain("Completed");
    expect(hiddenHistory).toContain("research this");
  });

  it("reloads collapsed and hidden prefs for bot A without applying them to bot B", () => {
    writeTaskPanelPref("bot-a", { collapsed: true, hidden: false });
    writeTaskPanelPref("bot-b", { hidden: true });
    const a = renderToStaticMarkup(
      createElement(TaskPanelView, {
        botId: "bot-a",
        tasks: [task({ id: "1", state: "pending", assignment: "only on A" })],
      }),
    );
    const b = renderToStaticMarkup(
      createElement(TaskPanelView, {
        botId: "bot-b",
        tasks: [task({ id: "2", state: "pending", assignment: "only on B" })],
      }),
    );
    expect(a).toContain("1 assigned / 1 active");
    expect(a).not.toContain("only on A");
    expect(b).toContain("Assigned tasks (1)");
    expect(b).not.toContain("only on B");
  });

  it("does not interrupt or delete when the panel is hidden", () => {
    const src = readFileSync(join(HERE, "TaskPanel.tsx"), "utf8");
    expect(src).not.toMatch(/interrupt|deleteForBot/);
    const markup = renderToStaticMarkup(
      createElement(TaskPanelView, {
        tasks: [task({ id: "1", state: "pending" })],
        visibility: "hidden",
      }),
    );
    expect(markup).toContain("Assigned tasks (1)");
  });

  it("keeps a NEEDS_INPUT option card sibling when the panel is hidden", () => {
    const markup = renderToStaticMarkup(
      createElement(
        "div",
        null,
        createElement(StoreProvider, null, createElement(OptionCard, { botId: "helper", message: needsInputMessage })),
        createElement(TaskPanelView, {
          tasks: [task({ id: "1", state: "pending" })],
          visibility: "hidden",
        }),
        createElement("div", { "data-testid": "composer" }, "composer"),
      ),
    );
    expect(markup).toContain("Allow once");
    expect(markup).toContain("Approval needed");
    expect(markup).toContain("composer");
    expect(markup).toContain("Assigned tasks (1)");
    expect(markup).not.toContain("Pending");
  });
});
