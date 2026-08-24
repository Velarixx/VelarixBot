import { describe, expect, it } from "vitest";

import { detectAttachmentMime, detectMimeFromBytes, detectMimeFromName } from "./mime.ts";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

describe("attachment MIME detection", () => {
  it("detects MIME from magic bytes", () => {
    expect(detectMimeFromBytes(PNG)).toBe("image/png");
    expect(detectMimeFromBytes(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(detectMimeFromBytes(Buffer.from("GIF89a......"))).toBe("image/gif");
    expect(detectMimeFromBytes(Buffer.from("RIFF\0\0\0\0WEBP...."))).toBe("image/webp");
    expect(detectMimeFromBytes(Buffer.from("%PDF-1.4"))).toBe("application/pdf");
    expect(detectMimeFromBytes(Uint8Array.from([0x4d, 0x5a, 0x90, 0x00]))).toBe(
      "application/vnd.microsoft.portable-executable",
    );
    expect(detectMimeFromBytes(Uint8Array.from([0x7f, 0x45, 0x4c, 0x46]))).toBe("application/x-executable");
    expect(detectMimeFromBytes(Buffer.from("hello"))).toBeUndefined();
  });

  it("detects MIME from filename and prefers bytes over a mismatched name", () => {
    expect(detectMimeFromName("shot.PNG")).toBe("image/png");
    expect(detectMimeFromName("notes.md")).toBe("text/markdown");
    expect(detectMimeFromName("C:\\\\drops\\\\tool.exe")).toBe("application/vnd.microsoft.portable-executable");
    expect(detectAttachmentMime({ name: "shot.jpg", bytes: PNG })).toBe("image/png");
    expect(detectAttachmentMime({ name: "shot.png", mime: "image/png" })).toBe("image/png");
    expect(detectAttachmentMime({ path: "note.txt" })).toBe("text/plain");
  });
});
