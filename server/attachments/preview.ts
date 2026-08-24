// Preview allow/deny by type. Never a gallery — only a policy decision.
// Secret config paths and executable types are denied. Preview text is
// redacted so secret values never appear.

import { extname } from "node:path";

import { redactSecrets } from "../redact-text.ts";
import { detectAttachmentMime } from "./mime.ts";
import { isSecretConfigPath } from "./storage.ts";

export type AttachmentPreviewKind = "image" | "text";

export type AttachmentPreviewDecision =
  | { allow: true; kind: AttachmentPreviewKind }
  | { allow: false; reason: string };

const PREVIEW_IMAGE = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const PREVIEW_TEXT = new Set(["text/plain", "text/markdown", "text/csv"]);

const DENY_MIME = new Set([
  "application/vnd.microsoft.portable-executable",
  "application/x-executable",
  "application/x-msdownload",
  "application/x-bat",
  "application/x-powershell",
  "application/x-sh",
  "application/javascript",
  "text/html",
  "application/pdf",
]);

const DENY_EXT = new Set([".exe", ".dll", ".bat", ".cmd", ".com", ".scr", ".ps1", ".msi", ".sh", ".js", ".mjs", ".html", ".htm"]);

function fileName(input: { name?: string; path?: string }): string {
  return (input.name || input.path || "").trim();
}

export function attachmentPreviewDecision(input: {
  name?: string;
  path?: string;
  mime?: string;
  bytes?: Uint8Array;
}): AttachmentPreviewDecision {
  const path = input.path?.trim();
  if (path && isSecretConfigPath(path)) {
    return { allow: false, reason: "secret configuration files cannot be previewed" };
  }
  const name = fileName(input);
  const ext = extname(name.replace(/\\/g, "/")).toLowerCase();
  if (DENY_EXT.has(ext)) {
    return { allow: false, reason: `preview is denied for ${ext || "this"} files` };
  }
  const mime = detectAttachmentMime(input);
  if (mime && DENY_MIME.has(mime)) {
    return { allow: false, reason: `preview is denied for ${mime}` };
  }
  if (mime && PREVIEW_IMAGE.has(mime)) return { allow: true, kind: "image" };
  if (mime && PREVIEW_TEXT.has(mime)) return { allow: true, kind: "text" };
  if (!mime) return { allow: false, reason: "preview is denied for unknown types" };
  return { allow: false, reason: `preview is denied for ${mime}` };
}

/** Redacted excerpt for an allowed text preview. Secret values never appear. */
export function attachmentPreviewExcerpt(text: string, maxChars = 400): string {
  const redacted = redactSecrets(String(text ?? ""));
  if (redacted.length <= maxChars) return redacted;
  return `${redacted.slice(0, maxChars)}…`;
}
