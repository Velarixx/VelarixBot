import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { projectRunInspector, type RunInspectorInput } from "@/lib/run-inspector";
import { RunInspectorView } from "./RunInspector";

function input(over: Partial<RunInspectorInput> = {}): RunInspectorInput {
  return {
    botId: "lead",
    busy: true,
    state: "RUNNING",
    messages: [
      { role: "user", kind: "text", at: 1_000, text: "go" },
      {
        role: "bot",
        kind: "activity",
        at: 4_000,
        tool: { name: "shell", command: "ls -la\nignored" },
      },
    ],
    tasks: [],
    now: 13_000,
    since: 1_000,
    ...over,
  };
}

function markup(fields = projectRunInspector(input()), open = true) {
  return renderToStaticMarkup(createElement(RunInspectorView, { fields, open }));
}

describe("RunInspectorView", () => {
  it("makes the Working-for pill a keyboard-reachable button, not a span control", () => {
    const html = markup(projectRunInspector(input()), false);
    expect(html).toContain("<button");
    expect(html).toContain("Working for 12s");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).not.toMatch(/<span[^>]*data-testid="run-inspector-pill"[^>]*>[\s\S]*<button/);
    expect(html).toMatch(/<button[^>]*type="button"/);
    expect(html).not.toContain('data-testid="run-inspector-panel"');
  });

  it("opens a panel with status, sanitized activity, and elapsed from the projection", () => {
    const html = markup(
      projectRunInspector(
        input({
          tasks: [
            {
              id: "t1",
              assigneeBotId: "lead",
              fromBotId: "lead",
              fromName: "Chief",
              sourceThreadId: "t",
              assignment: "draft the brief",
              state: "active",
              createdAt: 1,
              updatedAt: 1,
            },
          ],
        }),
      ),
    );
    expect(html).toContain('data-testid="run-inspector-panel"');
    expect(html).toContain('role="dialog"');
    expect(html).toContain("draft the brief");
    expect(html).toContain("shell · ls -la");
    expect(html).toContain("12s");
    expect(html).toContain('aria-label="Close"');
    expect(html).not.toContain("Delegated");
    expect(html).not.toContain('data-testid="run-inspector-blocked"');
  });

  it("redacts a token-shaped command in the panel", () => {
    const html = markup(
      projectRunInspector(
        input({
          messages: [
            { role: "user", kind: "text", at: 1_000, text: "go" },
            {
              role: "bot",
              kind: "activity",
              at: 2_000,
              tool: {
                name: "curl",
                command: "curl -H token=sk-live-supersecret https://example.test\n--data ok",
              },
            },
          ],
        }),
      ),
    );
    expect(html).not.toContain("sk-live-supersecret");
    expect(html).toContain("[redacted]");
    expect(html).not.toContain("--data ok");
  });

  it("omits delegated and blocked rows when those fields are absent", () => {
    const html = markup();
    expect(html).not.toContain('data-testid="run-inspector-delegated"');
    expect(html).not.toContain('data-testid="run-inspector-blocked"');
    expect(html).not.toContain("Delegated");
  });

  it("shows delegated and waiting rows only when the projection has them", () => {
    const html = markup(
      projectRunInspector(
        input({
          workflowStatus: "waiting",
          workflowWaitingFor: [{ botId: "helper", name: "Helper" }],
        }),
      ),
    );
    expect(html).toContain('data-testid="run-inspector-delegated"');
    expect(html).toContain("Waiting for @Helper");
    expect(html).toContain('data-testid="run-inspector-blocked"');
  });

  it("keeps a settled button that is not a live Working timer", () => {
    const fields = projectRunInspector(
      input({
        busy: false,
        state: "DONE",
        workflowStatus: "completed",
        now: 99_000,
        messages: [
          { role: "user", kind: "text", at: 1_000, text: "go" },
          {
            role: "bot",
            kind: "activity",
            at: 5_000,
            tool: { name: "shell", command: "echo ok", ok: true, status: "completed" },
          },
          { role: "bot", kind: "text", at: 7_000, text: "all set" },
        ],
      }),
    );
    const html = markup(fields, true);
    expect(html).toContain("<button");
    expect(html).not.toContain("Working for");
    expect(html).toContain("Completed");
    expect(html).toContain('data-testid="run-inspector-outcome"');
    expect(html).toContain("6s");
    expect(html).not.toContain("animate-bounce");
  });
});
