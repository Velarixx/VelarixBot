import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { Message } from "@/state/store";
import { AgentReportView } from "./AgentReport";

function report(over: Partial<Message> = {}): Message {
  return {
    id: "r1",
    role: "bot",
    kind: "text",
    at: 1,
    text: "here is the research",
    from: { botId: "helper", name: "Helper", color: "green" },
    report: { kind: "completion", fromBotId: "helper", taskId: "task-1" },
    ...over,
  };
}

describe("AgentReportView", () => {
  it("identifies the sending agent and the report kind", () => {
    const markup = renderToStaticMarkup(
      createElement(AgentReportView, { message: report(), onOpenTask: () => {} }),
    );
    expect(markup).toContain("Helper");
    expect(markup).toContain("Completed");
    expect(markup).toContain("here is the research");
    expect(markup).toContain("Open task details");
  });

  it("represents progress, blockers, and handoffs without duplicating identity", () => {
    const progress = renderToStaticMarkup(
      createElement(AgentReportView, {
        message: report({
          kind: "activity",
          text: undefined,
          tool: { name: "@Helper started" },
          report: { kind: "progress", fromBotId: "helper", taskId: "task-1" },
        }),
      }),
    );
    const blocker = renderToStaticMarkup(
      createElement(AgentReportView, {
        message: report({
          text: "needs a password",
          report: { kind: "blocker", fromBotId: "helper", taskId: "task-1" },
        }),
      }),
    );
    const handoff = renderToStaticMarkup(
      createElement(AgentReportView, {
        message: report({
          kind: "activity",
          text: undefined,
          tool: { name: "Delegated to @Helper" },
          from: { botId: "chief", name: "Chief" },
          report: { kind: "handoff", fromBotId: "chief", taskId: "task-1" },
        }),
      }),
    );
    expect(progress).toContain("Progress");
    expect(progress).toContain("@Helper started");
    expect(blocker).toContain("Blocked");
    expect(blocker).toContain("needs a password");
    expect(handoff).toContain("Handoff");
    expect(handoff).toContain("Chief");
  });

  it("sealed or reconciled progress does not retain animate-spin while delivery is pending or permanently failed", () => {
    for (const status of ["pending", "delivery_failed"] as const) {
      const markup = renderToStaticMarkup(
        createElement(AgentReportView, {
          message: report({
            kind: "activity",
            text: undefined,
            tool: { name: "@Helper started" },
            report: { kind: "progress", fromBotId: "helper", taskId: "task-1", status },
          }),
        }),
      );
      expect(markup).not.toContain("animate-spin");
    }
  });

  it("does not keep thinking for terminal, pending, failed, or delivery_failed progress", () => {
    for (const status of ["terminal", "pending", "failed", "delivery_failed"] as const) {
      const markup = renderToStaticMarkup(
        createElement(AgentReportView, {
          message: report({
            kind: "activity",
            text: undefined,
            tool: { name: "@Helper started" },
            report: { kind: "progress", fromBotId: "helper", taskId: "task-1", status },
          }),
        }),
      );
      expect(markup).not.toContain("animate-spin");
    }
  });
});
