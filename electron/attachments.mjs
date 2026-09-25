import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Clipboard bytes have no backing File path. Only persist bounded images. */
export function saveClipboardImage(directory, payload) {
  if (!(payload?.bytes instanceof Uint8Array) || !payload.bytes.length || payload.bytes.length > 25 * 1024 * 1024) {
    throw new Error("Image must contain between 1 byte and 25 MB.");
  }
  const bytes = Buffer.from(payload.bytes);
  const ext = payload.mime === "image/png" && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? "png"
    : payload.mime === "image/jpeg" && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? "jpg"
    : payload.mime === "image/webp" && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP" ? "webp" : null;
  if (!ext) throw new Error("Unsupported or invalid clipboard image.");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const name = `clipboard-${createHash("sha256").update(bytes).digest("hex")}.${ext}`;
  const path = join(directory, name);
  writeFileSync(path, bytes, { mode: 0o600 });
  return { path, name: `Pasted image.${ext}` };
}
