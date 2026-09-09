import { describe, expect, it } from "vitest";

import type { AgentTask } from "./agent-task";
import {
  elapsedSeconds,
  hasInspectableRun,
  projectRunInspector,
  runStartedAt,
  workingLabel,
  type RunInspectorInput,
  type RunInspectorMessage,
} from "./run-inspector";

function task(over: Partial<AgentTask> & Pick<AgentTask, "id" | "state">): AgentTask {
  return {
    assigneeBotId: "helper",
    fromBotId: "lead",
    fromName: "Chief",
    sourceThreadId: "t-lead",
    assignment: "research this",
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

function msg(over: Partial<RunInspectorMessage> & Pick<RunInspectorMessage, "role" | "kind" | "at">): RunInspectorMessage {
  return { ...over };
}

function input(over: Partial<RunInspectorInput> = {}): RunInspectorInput {
  return {
    botId: "lead",
    busy: true,
    state: "RUNNING",
    messages: [msg({ role: "user", kind: "text", at: 1_000, text: "go" })],
    tasks: [],
    now: 13_000,
    since: 1_000,
    ...over,
  };
}

describe("run inspector projection", () => {
  it("uses the same start instant as the Working-for pill", () => {
    const messages = [
      msg({ role: "user", kind: "text", at: 10, text: "first" }),
      msg({ role: "bot", kind: "text", at: 20, text: "ok" }),
      msg({ role: "user", kind: "text", at: 50, text: "again" }),
    ];
    expect(runStartedAt(messages, 99)).toBe(50);
    expect(elapsedSeconds(1_000, 13_000)).toBe(12);
    expect(workingLabel(12)).toBe("Working for 12s");
  });

  it("projects current task, latest sanitized activity, and live elapsed while busy", () => {
    const fields = projectRunInspector(
      input({
        tasks: [task({ id: "t1", assigneeBotId: "lead", state: "active", assignment: "draft the brief" })],
        messages: [
          msg({ role: "user", kind: "text", at: 1_000, text: "go" }),
          msg({
            role: "bot",
            kind: "activity",
            at: 4_000,
            tool: { name: "shell", command: "ls -la\nignored" },
          }),
        ],
      }),
    );
    expect(fields.active).toBe(true);
    expect(fields.pillLabel).toBe("Working for 12s");
    expect(fields.status).toBe("draft the brief");
    expect(fields.activity).toBe("shell · ls -la");
    expect(fields.elapsedSeconds).toBe(12);
    expect(fields.delegated).toBeUndefined();
    expect(fields.blocked).toBeUndefined();
    expect(fields.outcome).toBeUndefined();
  });

  it("redacts a token-shaped command the same way activity chips do", () => {
    const fields = projectRunInspector(
      input({
        stateDetail: "token=sk-live-supersecret",
        messages: [
          msg({ role: "user", kind: "text", at: 1_000, text: "go" }),
          msg({
            role: "bot",
            kind: "activity",
            at: 2_000,
            tool: {
              name: "curl",
              command: "curl -H token=sk-live-supersecret https://example.test\n--data ok",
            },
          }),
        ],
      }),
    );
    expect(fields.activity).not.toContain("sk-live-supersecret");
    expect(fields.activity).toContain("[redacted]");
    expect(fields.activity).not.toContain("--data ok");
    expect(fields.status).not.toContain("sk-live-supersecret");
    expect(fields.status).toContain("[redacted]");
  });

  it("omits delegated and blocked rows when the projection has none", () => {
    const fields = projectRunInspector(input());
    expect(fields.delegated).toBeUndefined();
    expect(fields.blocked).toBeUndefined();
    expect(fields).not.toHaveProperty("delegated", expect.anything());
  });

  it("shows delegated state only when a child or assignment is already projected", () => {
    const waiting = projectRunInspector(
      input({
        workflowStatus: "waiting",
        workflowWaitingFor: [{ botId: "helper", name: "Helper" }],
      }),
    );
    expect(waiting.delegated).toBe("Waiting for @Helper");
    expect(waiting.blocked).toBe("Waiting for @Helper");

    const child = projectRunInspector(
      input({
        workflowStatus: undefined,
        tasks: [task({ id: "t1", state: "active", assignment: "write the brief" })],
      }),
    );
    expect(child.delegated).toBe("Chief · write the brief");
    expect(child.blocked).toBeUndefined();

    const none = projectRunInspector(input({ workflowStatus: "working", tasks: [] }));
    expect(none.delegated).toBeUndefined();
    expect(none.blocked).toBeUndefined();
  });

  it("shows blocked or waiting only when that outcome is already on the projection", () => {
    const blocked = projectRunInspector(
      input({
        state: "BLOCKED",
        stateDetail: "needs a password",
        tasks: [
          task({
            id: "t1",
            assigneeBotId: "lead",
            state: "blocked",
            assignment: "unlock",
            blocker: "needs a password",
            blockerOwner: "user",
            nextAction: "Enter the vault password",
          }),
        ],
      }),
    );
    expect(blocked.blocked).toBe("needs a password");
    expect(blocked.status).toBe("unlock");

    const report = projectRunInspector(
      input({
        messages: [
          msg({ role: "user", kind: "text", at: 1_000, text: "go" }),
          msg({
            role: "bot",
            kind: "text",
            at: 2_000,
            text: "waiting on vault",
            report: { kind: "blocker", fromBotId: "helper" },
          }),
        ],
      }),
    );
    expect(report.blocked).toBe("waiting on vault");
  });

  it("freezes elapsed and keeps a terminal outcome after the run settles", () => {
    const fields = projectRunInspector(
      input({
        busy: false,
        state: "DONE",
        workflowStatus: "completed",
        now: 99_000,
        messages: [
          msg({ role: "user", kind: "text", at: 1_000, text: "go" }),
          msg({
            role: "bot",
            kind: "activity",
            at: 5_000,
            tool: { name: "shell", command: "echo ok", ok: true, status: "completed" },
          }),
          msg({ role: "bot", kind: "text", at: 7_000, text: "all set" }),
        ],
      }),
    );
    expect(fields.active).toBe(false);
    expect(fields.pillLabel).not.toMatch(/^Working for /);
    expect(fields.outcome).toBe("Completed");
    expect(fields.status).toBe("Completed");
    expect(fields.activity).toContain("echo ok");
    expect(fields.elapsedSeconds).toBe(6);
    expect(hasInspectableRun({ busy: false, messages: [] })).toBe(false);
    expect(hasInspectableRun({ busy: false, messages: [{ role: "user" }] })).toBe(true);
    expect(hasInspectableRun({ busy: true, messages: [] })).toBe(true);
  });
});
