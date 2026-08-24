import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const chat = readFileSync(join(HERE, "ChatView.tsx"), "utf8");

describe("lead chat workflow + task panel", () => {
  it("renders explicit workflow states and the autonomy stop reason", () => {
    expect(chat).toContain("workflowLabel");
    expect(chat).toContain("workflowWaitingFor");
    expect(chat).toContain("Autonomous execution stopped");
    expect(chat).toContain('aria-label="Full autonomy"');
    expect(chat).toContain("AgentReportView");
    expect(chat).toContain("TaskPanelView");
    expect(chat).toContain("tasksForBot");
  });
});
