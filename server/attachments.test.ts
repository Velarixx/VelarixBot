import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import {
  acpImageBlocks,
  agentAcceptsImagePrompts,
  attachmentPathRefs,
  claudeImageBlocks,
  codexImageInput,
  expandAttachmentPaths,
  isSecretConfigPath,
  readImageBytes,
} from "./attachments.ts";

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

  it("reads image bytes for Codex data URLs and ACP blocks, never from config.json", () => {
    const img = join(DATA_DIR, "shot.png");
    writeFileSync(img, PNG);
    const secret = join(DATA_DIR, "config.json");
    writeFileSync(secret, JSON.stringify({ github: { token: "ghp_secret_token" } }));
    const note = join(DATA_DIR, "note.md");
    writeFileSync(note, "hi");
    const items = [{ path: img, mime: "image/png" }, { path: secret }, { path: note }];

    const bytes = readImageBytes(items);
    expect(bytes).toHaveLength(1);
    expect(bytes[0].data).toBe(PNG.toString("base64"));

    const acp = acpImageBlocks(items);
    expect(acp).toEqual([{ type: "image", mimeType: "image/png", data: PNG.toString("base64") }]);
    expect(JSON.stringify(acp)).not.toContain("ghp_secret_token");

    const codex = codexImageInput(items);
    expect(codex).toEqual([{ type: "image", url: `data:image/png;base64,${PNG.toString("base64")}` }]);
    expect(JSON.stringify(codex)).not.toContain("ghp_secret_token");
  });

  it("falls back to Codex localImage path refs when bytes cannot be read", () => {
    const missing = join(DATA_DIR, "gone.png");
    expect(codexImageInput([{ path: missing, mime: "image/png" }])).toEqual([
      { type: "localImage", path: missing },
    ]);
  });

  it("does not treat missing ACP image capability as vision support", () => {
    expect(agentAcceptsImagePrompts(undefined)).toBe(false);
    expect(agentAcceptsImagePrompts({})).toBe(false);
    expect(agentAcceptsImagePrompts({ agentCapabilities: { promptCapabilities: { image: false } } })).toBe(false);
    expect(agentAcceptsImagePrompts({ agentCapabilities: { promptCapabilities: { image: true } } })).toBe(true);
    expect(agentAcceptsImagePrompts({ promptCapabilities: { image: true } })).toBe(true);
  });
});
