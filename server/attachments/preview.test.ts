import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { DATA_DIR } from "../config.ts";
import { attachmentPreviewDecision, attachmentPreviewExcerpt } from "./preview.ts";

describe("attachment preview policy", () => {
  it("allows images and plain text, denies executables and unknown types", () => {
    expect(attachmentPreviewDecision({ name: "shot.png", mime: "image/png" })).toEqual({ allow: true, kind: "image" });
    expect(attachmentPreviewDecision({ name: "notes.md" })).toEqual({ allow: true, kind: "text" });
    expect(attachmentPreviewDecision({ name: "tool.exe" }).allow).toBe(false);
    expect(attachmentPreviewDecision({ name: "page.html" }).allow).toBe(false);
    expect(attachmentPreviewDecision({ name: "blob.bin" }).allow).toBe(false);
  });

  it("denies secret config paths and never echoes secret values in excerpts", () => {
    const secret = join(DATA_DIR, "config.json");
    expect(attachmentPreviewDecision({ path: secret, name: "config.json", mime: "application/json" })).toEqual({
      allow: false,
      reason: "secret configuration files cannot be previewed",
    });
    const canary = ["fake", "preview", "canary", Date.now().toString(36)].join("-");
    const excerpt = attachmentPreviewExcerpt(`token=${canary}\nhello`);
    expect(excerpt).toContain("[redacted]");
    expect(excerpt).not.toContain(canary);
  });
});
