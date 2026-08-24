import { describe, expect, it } from "vitest";
import {
  AUTONOMY_STOP,
  isAutonomyContinueText,
  isWorkflowStatus,
  MAX_AUTONOMY_HOPS,
  waitingLabel,
  workflowLabel,
} from "./workflow";

describe("workflow labels", () => {
  it("identifies who the lead is waiting for", () => {
    expect(waitingLabel([])).toBe("Waiting for agent");
    expect(waitingLabel([{ botId: "h", name: "Helper" }])).toBe("Waiting for @Helper");
    expect(waitingLabel([
      { botId: "h", name: "Helper" },
      { botId: "w", name: "Writer" },
    ])).toBe("Waiting for @Helper and @Writer");
    expect(waitingLabel([
      { botId: "a", name: "A" },
      { botId: "b", name: "B" },
      { botId: "c", name: "C" },
    ])).toBe("Waiting for @A and 2 others");
  });

  it("covers the explicit lead-chat states", () => {
    expect(workflowLabel("working")).toBe("Working");
    expect(workflowLabel("waiting", [{ botId: "h", name: "Helper" }])).toBe("Waiting for @Helper");
    expect(workflowLabel("blocked")).toBe("Blocked");
    expect(workflowLabel("needs_input")).toBe("Needs input");
    expect(workflowLabel("paused")).toBe("Paused");
    expect(workflowLabel("completed")).toBe("Completed");
    expect(isWorkflowStatus("waiting")).toBe(true);
    expect(isWorkflowStatus("jogging")).toBe(false);
  });

  it("explains why autonomous execution stopped", () => {
    expect(AUTONOMY_STOP.off).toMatch(/Full-autonomy is off/i);
    expect(AUTONOMY_STOP.approval).toMatch(/safety-sensitive action needs approval/i);
    expect(AUTONOMY_STOP.boundary).toContain(String(MAX_AUTONOMY_HOPS));
    expect(AUTONOMY_STOP.peerBlocked("Helper", "needs approval")).toContain("@Helper");
    expect(isAutonomyContinueText("[Full-autonomy continue] Review")).toBe(true);
    expect(isAutonomyContinueText("please continue")).toBe(false);
  });
});
