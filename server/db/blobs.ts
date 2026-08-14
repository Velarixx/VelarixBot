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

const HASH_RE = /^[0-9a-f]{64}$/;

export function blobPath(hash: string): string {
  if (!HASH_RE.test(hash)) throw new Error("invalid blob hash");
  return join(blobsDir(), hash);
}

export function hashBytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Store base64 content; returns its content hash. Idempotent. */
export function putBlobBase64(base64: string): string {
  const bytes = Buffer.from(base64, "base64");
  const hash = hashBytes(bytes);
  const path = blobPath(hash);
  if (!existsSync(path)) {
    ensurePrivateDir(blobsDir());
    atomicWriteFileSync(path, bytes);
  }
  return hash;
}

/** Read a blob back as base64, or null when the file is missing. */
export function readBlobBase64(hash: string): string | null {
  try {
    return readFileSync(blobPath(hash)).toString("base64");
  } catch {
    return null;
  }
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
