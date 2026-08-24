import { describe, expect, it } from "vitest";

import {
  AUTONOMY_STOP,
  MAX_AUTONOMY_HOPS,
  removeWaitingFor,
  upsertWaitingFor,
  waitingLabel,
  workflowLabel,
} from "./workflow.ts";

describe("lead workflow helpers", () => {
  it("upserts and removes waiting-for agents without duplicates", () => {
    const first = upsertWaitingFor([], { botId: "h", name: "Helper" });
    const renamed = upsertWaitingFor(first, { botId: "h", name: "Helper Two" });
    expect(renamed).toEqual([{ botId: "h", name: "Helper Two" }]);
    const two = upsertWaitingFor(renamed, { botId: "w", name: "Writer" });
    expect(waitingLabel(two)).toBe("Waiting for @Helper Two and @Writer");
    expect(removeWaitingFor(two, "h")).toEqual([{ botId: "w", name: "Writer" }]);
    expect(workflowLabel("waiting", two)).toBe("Waiting for @Helper Two and @Writer");
  });

  it("names the configured safety boundary", () => {
    expect(MAX_AUTONOMY_HOPS).toBe(8);
    expect(AUTONOMY_STOP.boundary).toContain("8");
    expect(AUTONOMY_STOP.paused).toMatch(/paused/i);
    expect(AUTONOMY_STOP.completed).toMatch(/completed/i);
  });
});
