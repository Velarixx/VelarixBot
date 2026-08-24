// Safe-open policy: reveal or read an attachment without executing it.
// This module never spawns a process and never builds a command string.

import { extname } from "node:path";

import { detectAttachmentMime } from "./mime.ts";
import { isSecretConfigPath } from "./storage.ts";

export type SafeOpenMode = "reveal" | "read";

export type SafeOpenDecision =
  | { allowed: true; mode: SafeOpenMode }
  | { allowed: false; reason: string };

const EXECUTABLE_EXT = new Set([".exe", ".dll", ".bat", ".cmd", ".com", ".scr", ".ps1", ".msi", ".sh"]);
const EXECUTABLE_MIME = new Set([
  "application/vnd.microsoft.portable-executable",
  "application/x-executable",
  "application/x-msdownload",
  "application/x-bat",
  "application/x-powershell",
  "application/x-sh",
]);

/**
 * Decide how a local attachment may be opened. Callers must not spawn the
 * file — allowed only means reveal-in-folder or read-as-bytes.
 */
export function safeOpenAttachment(input: { path: string; name?: string; mime?: string; bytes?: Uint8Array }): SafeOpenDecision {
  const path = input.path.trim();
  if (!path) return { allowed: false, reason: "attachment path is empty" };
  if (isSecretConfigPath(path)) {
    return { allowed: false, reason: "secret configuration files cannot be opened" };
  }
  const name = (input.name || path).replace(/\\/g, "/");
  const ext = extname(name).toLowerCase();
  const mime = detectAttachmentMime({ ...input, name, path });
  if (EXECUTABLE_EXT.has(ext) || (mime && EXECUTABLE_MIME.has(mime))) {
    return { allowed: false, reason: "executable attachments cannot be opened" };
  }
  if (mime?.startsWith("image/") || mime?.startsWith("text/") || mime === "application/json") {
    return { allowed: true, mode: "read" };
  }
  return { allowed: true, mode: "reveal" };
}
