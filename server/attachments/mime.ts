// MIME detection from magic bytes and filename. Bytes win over name.
// VelarixBot-native — no extra image libraries.

import { extname } from "node:path";

const NAME_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".pdf": "application/pdf",
  ".html": "text/html",
  ".htm": "text/html",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".exe": "application/vnd.microsoft.portable-executable",
  ".dll": "application/vnd.microsoft.portable-executable",
  ".bat": "application/x-bat",
  ".cmd": "application/x-bat",
  ".com": "application/x-msdownload",
  ".scr": "application/x-msdownload",
  ".ps1": "application/x-powershell",
  ".msi": "application/x-msdownload",
  ".sh": "application/x-sh",
};

function asciiAt(bytes: Uint8Array, offset: number, text: string): boolean {
  if (offset + text.length > bytes.length) return false;
  for (let i = 0; i < text.length; i++) {
    if (bytes[offset + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

/** Detect MIME from a leading magic-byte signature. */
export function detectMimeFromBytes(bytes: Uint8Array): string | undefined {
  if (bytes.length >= 8 && bytes[0] === 0x89 && asciiAt(bytes, 1, "PNG") && bytes[4] === 0x0d && bytes[5] === 0x0a) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.length >= 6 && asciiAt(bytes, 0, "GIF87a")) return "image/gif";
  if (bytes.length >= 6 && asciiAt(bytes, 0, "GIF89a")) return "image/gif";
  if (bytes.length >= 12 && asciiAt(bytes, 0, "RIFF") && asciiAt(bytes, 8, "WEBP")) {
    return "image/webp";
  }
  if (bytes.length >= 5 && asciiAt(bytes, 0, "%PDF-")) return "application/pdf";
  if (bytes.length >= 2 && bytes[0] === 0x4d && bytes[1] === 0x5a) {
    return "application/vnd.microsoft.portable-executable";
  }
  if (bytes.length >= 4 && bytes[0] === 0x7f && asciiAt(bytes, 1, "ELF")) {
    return "application/x-executable";
  }
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07) && (bytes[3] === 0x04 || bytes[3] === 0x06 || bytes[3] === 0x08)) {
    return "application/zip";
  }
  return undefined;
}

/** Detect MIME from a filename or path extension. */
export function detectMimeFromName(name: string): string | undefined {
  const ext = extname(name.replace(/\\/g, "/")).toLowerCase();
  return NAME_MIME[ext];
}

/**
 * Resolve an attachment MIME. Declared image/* is trusted; otherwise
 * magic bytes win, then the filename extension.
 */
export function detectAttachmentMime(input: {
  name?: string;
  path?: string;
  mime?: string;
  bytes?: Uint8Array;
}): string | undefined {
  if (input.mime && input.mime.includes("/") && input.mime !== "application/octet-stream") {
    if (input.mime.startsWith("image/") || !input.bytes) return input.mime;
  }
  if (input.bytes?.length) {
    const fromBytes = detectMimeFromBytes(input.bytes);
    if (fromBytes) return fromBytes;
  }
  if (input.mime && input.mime.includes("/")) return input.mime;
  return detectMimeFromName(input.path || input.name || "");
}

/** Image media type for vision blocks — never invent vision for non-images. */
export function detectImageMediaType(item: { path: string; mime?: string; bytes?: Uint8Array }): string | undefined {
  const mime = detectAttachmentMime(item);
  return mime?.startsWith("image/") ? mime : undefined;
}
