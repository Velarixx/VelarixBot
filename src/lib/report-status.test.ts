import { describe, expect, it } from "vitest";

import { reportShowsThinking } from "./report-status";

describe("reportShowsThinking", () => {
  it("spins only for unsettled progress", () => {
    expect(reportShowsThinking({ kind: "progress" })).toBe(true);
    expect(reportShowsThinking({ kind: "completion" })).toBe(false);
    expect(reportShowsThinking({ kind: "blocker" })).toBe(false);
    expect(reportShowsThinking({ kind: "handoff" })).toBe(false);
  });

  it("never thinks for terminal, pending, failed, or delivery_failed", () => {
    for (const status of ["terminal", "pending", "failed", "delivery_failed"] as const) {
      expect(reportShowsThinking({ kind: "progress", status })).toBe(false);
      expect(reportShowsThinking({ kind: "completion", status })).toBe(false);
    }
  });
});
