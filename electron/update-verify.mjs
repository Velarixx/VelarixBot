// SHA256SUMS.txt verification for unsigned GitHub Releases.
// Releases are not code-signed; the checksum file on the same release is
// the trust check. Fail closed if the asset is missing from the manifest
// or the digest does not match. Token never appears here.
import { createHash, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";

export function parseSha256Sums(text) {
  const map = new Map();
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const m = line.match(/^([a-fA-F0-9]{64})\s+\*?(.+?)\s*$/);
    if (!m) continue;
    const name = String(m[2]).replace(/^\.\//, "").split(/[/\\]/).pop();
    if (name) map.set(name, m[1].toLowerCase());
  }
  return map;
}

export function expectedHashForAsset(sums, assetName) {
  if (!sums || typeof sums.get !== "function") return "";
  const base = String(assetName ?? "").split(/[/\\]/).pop();
  return String(sums.get(base) ?? "").toLowerCase();
}

export function hashesEqual(actual, expected) {
  const left = Buffer.from(String(actual ?? "").toLowerCase(), "utf8");
  const right = Buffer.from(String(expected ?? "").toLowerCase(), "utf8");
  if (!left.length || left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export async function sha256File(path, { readStream = createReadStream, hash = createHash } = {}) {
  const digest = hash("sha256");
  const stream = readStream(path);
  for await (const chunk of stream) digest.update(chunk);
  return digest.digest("hex");
}

export async function verifyDownload({ filePath, assetName, sumsText }) {
  const sums = parseSha256Sums(sumsText);
  const expected = expectedHashForAsset(sums, assetName);
  if (!expected) {
    return {
      ok: false,
      message: `SHA256SUMS.txt has no entry for ${String(assetName ?? "this installer")}.`,
    };
  }
  const actual = await sha256File(filePath);
  if (!hashesEqual(actual, expected)) {
    return { ok: false, message: "Download did not match SHA256SUMS.txt. The file was discarded." };
  }
  return { ok: true, sha256: actual };
}
