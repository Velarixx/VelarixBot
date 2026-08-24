import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { DATA_DIR } from "../config.ts";
import { summarizeAttachment } from "./summary.ts";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

describe("attachment summaries", () => {
  it("summarizes metadata and image dimensions without echoing secrets", () => {
    const canary = ["fake", "summary", "canary", Date.now().toString(36)].join("-");
    const summary = summarizeAttachment({
      name: "shot.png",
      mime: "image/png",
      bytes: PNG,
      sizeBytes: PNG.length,
    });
    expect(summary).toMatchObject({ name: "shot.png", mime: "image/png", width: 1, height: 1, sizeBytes: PNG.length });
    expect(JSON.stringify(summary)).not.toContain(canary);

    const secret = summarizeAttachment({
      path: join(DATA_DIR, "config.json"),
      name: "config.json",
      bytes: Buffer.from(JSON.stringify({ github: { token: canary } })),
    });
    expect(secret.note).toMatch(/secret configuration/);
    expect(secret).not.toHaveProperty("sizeBytes");
    expect(JSON.stringify(secret)).not.toContain(canary);
  });
});
