// Extract raster dimensions from well-known image headers. No extra deps.

export interface ImageDimensions {
  width: number;
  height: number;
}

function u16be(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function u16le(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function u32be(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

function u24le(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function pngDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  if (bytes.length < 24) return undefined;
  if (bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) return undefined;
  const width = u32be(bytes, 16);
  const height = u32be(bytes, 20);
  if (!width || !height || width > 0xffff || height > 0xffff) return undefined;
  return { width, height };
}

function gifDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  if (bytes.length < 10) return undefined;
  if (bytes[0] !== 0x47 || bytes[1] !== 0x49 || bytes[2] !== 0x46) return undefined;
  const width = u16le(bytes, 6);
  const height = u16le(bytes, 8);
  if (!width || !height) return undefined;
  return { width, height };
}

function jpegDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  let offset = 2;
  while (offset + 8 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1];
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = u16be(bytes, offset + 2);
    if (length < 2) return undefined;
    const sof = marker === 0xc0 || marker === 0xc1 || marker === 0xc2 || marker === 0xc3;
    if (sof && offset + 8 < bytes.length) {
      const height = u16be(bytes, offset + 5);
      const width = u16be(bytes, offset + 7);
      if (width && height) return { width, height };
      return undefined;
    }
    offset += 2 + length;
  }
  return undefined;
}

function webpDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  if (bytes.length < 30) return undefined;
  if (
    bytes[0] !== 0x52 ||
    bytes[1] !== 0x49 ||
    bytes[2] !== 0x46 ||
    bytes[3] !== 0x46 ||
    bytes[8] !== 0x57 ||
    bytes[9] !== 0x45 ||
    bytes[10] !== 0x42 ||
    bytes[11] !== 0x50
  ) {
    return undefined;
  }
  const fourcc = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
  if (fourcc === "VP8X") {
    const width = u24le(bytes, 24) + 1;
    const height = u24le(bytes, 27) + 1;
    if (width && height) return { width, height };
    return undefined;
  }
  if (fourcc === "VP8 " && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    return { width: u16le(bytes, 26) & 0x3fff, height: u16le(bytes, 28) & 0x3fff };
  }
  if (fourcc === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) {
    const bits = bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  return undefined;
}

/** Width/height from PNG, JPEG, GIF, or WEBP headers. */
export function extractImageDimensions(bytes: Uint8Array, mime?: string): ImageDimensions | undefined {
  const hinted = mime?.toLowerCase();
  if (hinted === "image/png") return pngDimensions(bytes);
  if (hinted === "image/jpeg") return jpegDimensions(bytes);
  if (hinted === "image/gif") return gifDimensions(bytes);
  if (hinted === "image/webp") return webpDimensions(bytes);
  return pngDimensions(bytes) ?? jpegDimensions(bytes) ?? gifDimensions(bytes) ?? webpDimensions(bytes);
}
