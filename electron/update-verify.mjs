// SHA256SUMS.txt verification for unsigned GitHub Releases.
// Releases are not code-signed; the checksum file on the same release is
// the trust check. Fail closed if the asset is missing from the manifest
// or the digest does not match. Token never appears here.
import { createHash, timingSafeEqual } from "node:crypto";
import { createReadStream, readFileSync } from "node:fs";
import { join } from "node:path";

export const VERIFIED_DOWNLOAD_FILE = "verified-download.json";

export function verifiedDownloadRecordPath(dir) {
  return join(dir, VERIFIED_DOWNLOAD_FILE);
}

export function parseVerifiedDownloadRecord(text) {
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") return null;
    const path = typeof parsed.path === "string" ? parsed.path : "";
    const sha256 = String(parsed.sha256 ?? "").toLowerCase();
    if (!path || !/^[a-f0-9]{64}$/.test(sha256)) return null;
    return {
      path,
      sha256,
      version: typeof parsed.version === "string" ? parsed.version : undefined,
      assetName: typeof parsed.assetName === "string" ? parsed.assetName : undefined,
    };
  } catch {
    return null;
  }
}

export function serializeVerifiedDownloadRecord({ path, sha256, version, assetName } = {}) {
  return JSON.stringify({
    path,
    sha256: String(sha256 ?? "").toLowerCase(),
    ...(version ? { version } : {}),
    ...(assetName ? { assetName } : {}),
  });
}

export async function restoreVerifiedDownload(record, { fileExists, sha256Of } = {}) {
  if (!record?.path || !record?.sha256) return { ok: false };
  if (typeof fileExists === "function") {
    const exists = await Promise.resolve(fileExists(record.path));
    if (!exists) return { ok: false };
  }
  if (typeof sha256Of === "function") {
    const actual = await sha256Of(record.path);
    if (!hashesEqual(actual, record.sha256)) return { ok: false };
  }
  return {
    ok: true,
    path: record.path,
    sha256: record.sha256,
    version: record.version,
    assetName: record.assetName,
  };
}

export async function reusePersistedDownload({ record, availableVersion, fileExists, sha256Of } = {}) {
  if (!record) return { ok: false };
  if (availableVersion && record.version && String(record.version) !== String(availableVersion)) {
    return { ok: false };
  }
  return restoreVerifiedDownload(record, { fileExists, sha256Of });
}

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

export function sha256FileSync(path, { readFile = readFileSync, hash = createHash } = {}) {
  return hash("sha256").update(readFile(path)).digest("hex");
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
