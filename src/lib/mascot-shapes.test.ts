import { describe, expect, it } from "vitest";
import { ICON_SHAPE_NAMES, ICON_SHAPES, resolveIconShape, shapeFor } from "./mascot-shapes";

describe("agent icon shapes", () => {
  it("offers meaningfully different silhouettes, not only arrow variants", () => {
    expect(ICON_SHAPE_NAMES).toEqual([
      "cursor",
      "blob",
      "circle",
      "squircle",
      "diamond",
      "hexagon",
      "teardrop",
      "shield",
    ]);
    const bodies = ICON_SHAPES.map((s) => s.body);
    expect(new Set(bodies).size).toBe(ICON_SHAPES.length);
    expect(ICON_SHAPE_NAMES.filter((n) => n !== "cursor").length).toBeGreaterThanOrEqual(6);
  });

  it("keeps a face anchor and clip for sidebar and compact sizes", () => {
    for (const shape of ICON_SHAPES) {
      expect(shape.clip.length).toBeGreaterThan(10);
      expect(shape.body).toContain("{{GRADIENT}}");
      expect(shape.anchor.scale).toBeGreaterThan(0.3);
      expect(shape.anchor.scale).toBeLessThan(1);
    }
  });

  it("falls back to the cursor arrow for missing or unknown names", () => {
    expect(resolveIconShape(undefined)).toBe("cursor");
    expect(resolveIconShape("")).toBe("cursor");
    expect(resolveIconShape("arrow")).toBe("cursor");
    expect(shapeFor(null).name).toBe("cursor");
    expect(shapeFor("hexagon").name).toBe("hexagon");
  });
});
