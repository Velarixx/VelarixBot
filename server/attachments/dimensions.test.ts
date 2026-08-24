import { describe, expect, it } from "vitest";

import { extractImageDimensions } from "./dimensions.ts";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function jpeg(width: number, height: number): Uint8Array {
  return Uint8Array.from([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, (height >> 8) & 0xff, height & 0xff, (width >> 8) & 0xff, width & 0xff,
    0x01, 0x01, 0x11, 0x00, 0xff, 0xd9,
  ]);
}

function gif(width: number, height: number): Uint8Array {
  return Uint8Array.from([
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61, width & 0xff, (width >> 8) & 0xff, height & 0xff, (height >> 8) & 0xff,
  ]);
}

function webpVp8x(width: number, height: number): Uint8Array {
  const w = width - 1;
  const h = height - 1;
  return Uint8Array.from([
    0x52, 0x49, 0x46, 0x46, 0x16, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x58, 0x0a, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, w & 0xff, (w >> 8) & 0xff, (w >> 16) & 0xff, h & 0xff, (h >> 8) & 0xff, (h >> 16) & 0xff,
  ]);
}

describe("attachment dimensions", () => {
  it("extracts width and height from PNG, JPEG, GIF, and WEBP headers", () => {
    expect(extractImageDimensions(PNG_1X1, "image/png")).toEqual({ width: 1, height: 1 });
    expect(extractImageDimensions(jpeg(32, 16), "image/jpeg")).toEqual({ width: 32, height: 16 });
    expect(extractImageDimensions(gif(3, 2), "image/gif")).toEqual({ width: 3, height: 2 });
    expect(extractImageDimensions(webpVp8x(4, 5), "image/webp")).toEqual({ width: 4, height: 5 });
    expect(extractImageDimensions(Buffer.from("not-an-image"))).toBeUndefined();
  });
});
