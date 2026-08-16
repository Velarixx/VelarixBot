// Content-hash blob store: message screenshots (and any future file bytes)
// stay ON DISK under ~/.velarixbot/blobs/<sha256>, never inside SQLite —
// rows carry only the hash. Content addressing makes writes idempotent and
// crash-tolerant: a duplicate write is a no-op, an orphaned file (its row's
// transaction rolled back) is harmless and reclaimed by gcBlobs.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { atomicWriteFileSync, ensurePrivateDir } from "../atomic.ts";
import { DATA_DIR } from "../config.ts";

export function blobsDir(): string {
  return join(DATA_DIR, "blobs");
}

export const HASH_RE = /^[0-9a-f]{64}$/;

export function validBlobHash(v: unknown): v is string {
  return typeof v === "string" && HASH_RE.test(v);
}

export function blobPath(hash: string): string {
  if (!HASH_RE.test(hash)) throw new Error("invalid blob hash");
  return join(blobsDir(), hash);
}

export function hashBytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Store raw bytes; returns the content hash. Idempotent. */
export function putBlob(bytes: Buffer): string {
  const hash = hashBytes(bytes);
  const path = blobPath(hash);
  if (!existsSync(path)) {
    ensurePrivateDir(blobsDir());
    atomicWriteFileSync(path, bytes);
  }
  return hash;
}

/** Store base64 content; returns its content hash. Idempotent. */
export function putBlobBase64(base64: string): string {
  return putBlob(Buffer.from(base64, "base64"));
}

/** Read a blob back as bytes, or null when the file is missing. */
export function readBlob(hash: string): Buffer | null {
  try {
    return readFileSync(blobPath(hash));
  } catch {
    return null;
  }
}

/** Read a blob back as base64, or null when the file is missing. */
export function readBlobBase64(hash: string): string | null {
  const bytes = readBlob(hash);
  return bytes ? bytes.toString("base64") : null;
}

export function deleteBlob(hash: string): void {
  try {
    unlinkSync(blobPath(hash));
  } catch {
    /* already gone */
  }
}

export function listBlobs(): string[] {
  try {
    return readdirSync(blobsDir()).filter((name) => HASH_RE.test(name));
  } catch {
    return [];
  }
}

/** Remove blob files whose hash the caller no longer references. */
export function gcBlobs(referenced: ReadonlySet<string>): number {
  let removed = 0;
  for (const hash of listBlobs()) {
    if (referenced.has(hash)) continue;
    deleteBlob(hash);
    removed++;
  }
  return removed;
}
