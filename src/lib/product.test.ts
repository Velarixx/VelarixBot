import { describe, expect, it } from "vitest";
import { formatCompactTokens, formatUsageCost, stateLabel } from "./product";

describe("product UI formatting", () => {
  it("formats token counts compactly", () => {
    expect(formatCompactTokens(999)).toBe("999");
    expect(formatCompactTokens(1_250)).toBe("1.3k");
    expect(formatCompactTokens(1_000_000)).toBe("1m");
  });

  it("formats provider cost without inventing unknown costs", () => {
    expect(formatUsageCost(null)).toBe("cost unavailable");
    expect(formatUsageCost(0)).toBe("$0.00");
    expect(formatUsageCost(0.0123)).toBe("$0.012");
    expect(formatUsageCost(1.5)).toBe("$1.50");
  });

  it("uses readable labels for explicit bot states", () => {
    expect(stateLabel("NEEDS_INPUT")).toBe("Needs input");
    expect(stateLabel("RUNNING")).toBe("Running");
  });
});
