import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import { attachmentPathRefs, claudeImageBlocks, expandAttachmentPaths, isSecretConfigPath } from "./attachments.ts";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

describe("attachment paths", () => {
  it("expands folders with a recursion cap and skips config.json secrets", () => {
    const root = join(DATA_DIR, "drop");
    mkdirSync(join(root, "nested", "deep"), { recursive: true });
    writeFileSync(join(root, "a.txt"), "a");
    writeFileSync(join(root, "nested", "b.txt"), "b");
    writeFileSync(join(root, "nested", "deep", "c.txt"), "c");
    mkdirSync(join(DATA_DIR), { recursive: true });
    writeFileSync(join(DATA_DIR, "config.json"), JSON.stringify({ box: { token: "tok_secret_value" } }));

    const files = expandAttachmentPaths([root, join(DATA_DIR, "config.json")], { maxDepth: 1, maxFiles: 10 });
    expect(files.some((p) => p.endsWith("a.txt"))).toBe(true);
    expect(files.some((p) => p.endsWith("b.txt"))).toBe(true);
    expect(files.some((p) => p.endsWith("c.txt"))).toBe(false);
    expect(files.some((p) => p.endsWith("config.json"))).toBe(false);
    expect(isSecretConfigPath(join(DATA_DIR, "config.json"))).toBe(true);
  });

  it("formats path refs in user text without embedding secrets", () => {
    const secret = join(DATA_DIR, "config.json");
    const note = join(DATA_DIR, "note.md");
    expect(attachmentPathRefs("hi", [note, secret])).toBe(`hi\n\nAttached files:\n- ${note}`);
    expect(attachmentPathRefs("", [note])).toBe(`Attached files:\n- ${note}`);
  });

  it("builds Claude image blocks from file bytes, never from config.json", () => {
    const img = join(DATA_DIR, "shot.png");
    writeFileSync(img, PNG);
    const secret = join(DATA_DIR, "config.json");
    writeFileSync(secret, JSON.stringify({ github: { token: "ghp_secret_token" } }));
    const blocks = claudeImageBlocks([
      { path: img, mime: "image/png" },
      { path: secret },
      { path: join(DATA_DIR, "note.md") },
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: "image", source: { type: "base64", media_type: "image/png" } });
    expect(blocks[0].source.data).toBe(PNG.toString("base64"));
    expect(JSON.stringify(blocks)).not.toContain("ghp_secret_token");
  });
});
