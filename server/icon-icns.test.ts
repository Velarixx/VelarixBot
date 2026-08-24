import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const ICNS = join(root, "build", "icon.icns");
const SCRIPT = join(root, "scripts", "add-icon-padding.py");
const SVG = join(root, "build", "icon.svg");
const APP_ICON = join(root, "electron", "resources", "app-icon.png");
/** git hash-object of the rc.4 icns that still looked oversized in the Dock. */
const RC4_ICNS_BLOB = "760ebfdda80f51d5718e3c305699ff2d5cb9c224";

function icnsTypes(buf: Buffer): string[] {
  expect(buf.subarray(0, 4).toString("ascii")).toBe("icns");
  const types: string[] = [];
  let off = 8;
  while (off + 8 <= buf.length) {
    const ostype = buf.subarray(off, off + 4).toString("ascii");
    const length = buf.readUInt32BE(off + 4);
    if (length < 8 || off + length > buf.length) break;
    types.push(ostype);
    off += length;
  }
  return types;
}

function icnsPng(buf: Buffer, ostype: string): Buffer {
  let off = 8;
  while (off + 8 <= buf.length) {
    const type = buf.subarray(off, off + 4).toString("ascii");
    const length = buf.readUInt32BE(off + 4);
    const payload = buf.subarray(off + 8, off + length);
    if (type === ostype) return payload;
    off += length;
  }
  throw new Error(`missing icns type ${ostype}`);
}

/** 8-bit RGBA PNG → pixel buffer. Dock-icon assets are this format. */
function decodeRgbaPng(png: Buffer): { width: number; height: number; data: Buffer } {
  expect(png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))).toBe(true);
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idats: Buffer[] = [];
  let off = 8;
  while (off + 12 <= png.length) {
    const len = png.readUInt32BE(off);
    const type = png.subarray(off + 4, off + 8).toString("ascii");
    const data = png.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8]!;
      colorType = data[9]!;
    } else if (type === "IDAT") {
      idats.push(data);
    } else if (type === "IEND") {
      break;
    }
    off += 12 + len;
  }
  expect(bitDepth).toBe(8);
  expect(colorType).toBe(6); // RGBA
  const inflated = inflateSync(Buffer.concat(idats));
  const stride = width * 4;
  const out = Buffer.alloc(height * stride);
  let src = 0;
  for (let y = 0; y < height; y++) {
    const filter = inflated[src++]!;
    const row = inflated.subarray(src, src + stride);
    src += stride;
    const dest = y * stride;
    if (filter === 0) {
      row.copy(out, dest);
    } else if (filter === 1) {
      for (let i = 0; i < stride; i++) {
        const left = i >= 4 ? out[dest + i - 4]! : 0;
        out[dest + i] = (row[i]! + left) & 255;
      }
    } else if (filter === 2) {
      for (let i = 0; i < stride; i++) {
        const up = y > 0 ? out[dest - stride + i]! : 0;
        out[dest + i] = (row[i]! + up) & 255;
      }
    } else if (filter === 3) {
      for (let i = 0; i < stride; i++) {
        const left = i >= 4 ? out[dest + i - 4]! : 0;
        const up = y > 0 ? out[dest - stride + i]! : 0;
        out[dest + i] = (row[i]! + Math.floor((left + up) / 2)) & 255;
      }
    } else if (filter === 4) {
      for (let i = 0; i < stride; i++) {
        const a = i >= 4 ? out[dest + i - 4]! : 0;
        const b = y > 0 ? out[dest - stride + i]! : 0;
        const c = i >= 4 && y > 0 ? out[dest - stride + i - 4]! : 0;
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        out[dest + i] = (row[i]! + pr) & 255;
      }
    } else {
      throw new Error(`unsupported PNG filter ${filter}`);
    }
  }
  return { width, height, data: out };
}

function opaqueScale(png: Buffer, alphaThreshold = 16): number {
  const { width, height, data } = decodeRgbaPng(png);
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const a = data[(y * width + x) * 4 + 3]!;
      if (a <= alphaThreshold) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  expect(maxX).toBeGreaterThanOrEqual(0);
  const contentW = maxX - minX + 1;
  const contentH = maxY - minY + 1;
  return Math.max(contentW / width, contentH / height);
}

describe("macOS Dock icon", () => {
  it("uses a 60% Apple-grid inset and packs every iconset size into icns", () => {
    const script = readFileSync(SCRIPT, "utf8");
    expect(script).toMatch(/TARGET_SCALE = 0\.60/);
    expect(script).toContain('b"icp4"');
    expect(script).toContain('b"icp5"');
    expect(script).toContain('b"icp6"');
    expect(script).not.toMatch(/os\.system\s*\(/);
    expect(script).not.toMatch(/shell\s*=\s*True/);

    const svg = readFileSync(SVG, "utf8");
    expect(svg).toMatch(/scale\(0\.6\)/);
    expect(svg).toContain("translate(204.8 204.8)");

    const icns = readFileSync(ICNS);
    const types = icnsTypes(icns);
    expect(types[0]).toBe("TOC ");
    for (const need of ["icp4", "icp5", "icp6", "ic07", "ic08", "ic09", "ic10", "ic11", "ic12", "ic13", "ic14"]) {
      expect(types).toContain(need);
    }

    const scale = opaqueScale(icnsPng(icns, "ic10"));
    expect(scale).toBeLessThanOrEqual(0.62);
    expect(scale).toBeGreaterThan(0.52);

    // dock.setIcon uses this PNG at runtime and would undo icns padding
    expect(opaqueScale(readFileSync(APP_ICON))).toBeLessThanOrEqual(0.62);
    expect(opaqueScale(readFileSync(APP_ICON))).toBeGreaterThan(0.52);

    const blob = createHash("sha1")
      .update(Buffer.from(`blob ${icns.length}\0`))
      .update(icns)
      .digest("hex");
    expect(blob).not.toBe(RC4_ICNS_BLOB);
  });
});
