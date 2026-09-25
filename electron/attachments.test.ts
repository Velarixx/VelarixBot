import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
// @ts-expect-error Plain Electron module.
import { saveClipboardImage } from "./attachments.mjs";

it("persists bounded, validated clipboard bytes under a generated filename", () => {
  const dir = mkdtempSync(join(tmpdir(), "velarix-clipboard-"));
  try {
    const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1cAAAAASUVORK5CYII=", "base64");
    const result = saveClipboardImage(dir, { bytes, mime: "image/png", name: "../../outside.png" });
    expect(result.path.startsWith(dir)).toBe(true);
    expect(readFileSync(result.path)).toEqual(bytes);
    expect(() => saveClipboardImage(dir, { bytes: Buffer.from("not an image"), mime: "image/png" })).toThrow();
    expect(() => saveClipboardImage(dir, { bytes, mime: "text/html" })).toThrow();
    expect(() => saveClipboardImage(dir, { bytes: new Uint8Array(25 * 1024 * 1024 + 1), mime: "image/png" })).toThrow();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
