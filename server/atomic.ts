// Durable, private file writes (temp file + rename, 0600):
// write to a temp file, fsync the file so its bytes are on disk BEFORE the
// rename publishes them, rename over the target (atomic on one filesystem),
// then fsync the directory so the rename itself survives a power cut.
// Windows cannot open a directory for fsync — the rename is still atomic
// there, so the directory sync is best-effort by design.
//
// Everything under ~/.velarixbot is user-private: transcripts, API keys,
// approval rules. Files are created 0600 and directories 0700 (mode bits
// are effectively a no-op on win32, which is fine — NTFS ACLs already
// scope the profile directory to the user).
import { chmodSync, closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, renameSync, writeSync } from "node:fs";
import { dirname } from "node:path";

export const PRIVATE_DIR_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

/** mkdir -p with 0700, tightening a pre-existing dir's mode too. */
export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  try {
    chmodSync(dir, PRIVATE_DIR_MODE);
  } catch {
    /* best-effort on exotic filesystems */
  }
}

function fsyncDir(dir: string): void {
  try {
    const fd = openSync(dir, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    /* win32 cannot open directories — rename is already atomic there */
  }
}

/** Crash-safe replace: a reader always sees either the old or the new
 * content, never a torn file — even through a kill or power loss. */
export function atomicWriteFileSync(path: string, data: string | Buffer, opts: { backup?: boolean } = {}): void {
  const temp = `${path}.${process.pid}.tmp`;
  const fd = openSync(temp, "w", PRIVATE_FILE_MODE);
  try {
    let offset = 0;
    const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    while (offset < buf.length) offset += writeSync(fd, buf, offset);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (opts.backup && existsSync(path)) copyFileSync(path, `${path}.bak`);
  renameSync(temp, path);
  fsyncDir(dirname(path));
}
