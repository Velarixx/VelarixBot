import { describe, expect, it } from "vitest";

import { DEFAULT_INLINE_MAX_BYTES, degradeIfOversized, oversizedMetadataStub } from "./oversized.ts";

describe("oversized attachment degradation", () => {
  it("degrades an oversized file to a metadata stub without bytes", () => {
    const sizeBytes = DEFAULT_INLINE_MAX_BYTES + 12;
    const result = degradeIfOversized({ name: "huge.bin", mime: "application/octet-stream", sizeBytes });
    expect(result.oversized).toBe(true);
    if (!result.oversized) throw new Error("expected stub");
    expect(result.stub).toEqual(
      oversizedMetadataStub({ name: "huge.bin", mime: "application/octet-stream", sizeBytes }),
    );
    expect(result.stub.kind).toBe("oversized-stub");
    expect(result.stub).not.toHaveProperty("data");
    expect(result.stub).not.toHaveProperty("bytes");
    expect(degradeIfOversized({ name: "ok.txt", sizeBytes: 12 })).toEqual({ oversized: false });
  });
});
