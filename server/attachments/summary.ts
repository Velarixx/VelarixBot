// Attachment summaries: name, type, size, optional dimensions.
// Never include file bytes or secret values.

import { basename } from "node:path";

import { redactSecrets } from "../redact-text.ts";
import { extractImageDimensions } from "./dimensions.ts";
import { detectAttachmentMime } from "./mime.ts";
import { isSecretConfigPath } from "./storage.ts";

export interface AttachmentSummary {
  name: string;
  mime?: string;
  sizeBytes?: number;
  width?: number;
  height?: number;
  note?: string;
}

function displayName(input: { name?: string; path?: string }): string {
  const raw = (input.name || input.path || "attachment").trim() || "attachment";
  return redactSecrets(basename(raw.replace(/\\/g, "/")));
}

/** Metadata-only summary. Secret config paths yield a note, never contents. */
export function summarizeAttachment(input: {
  name?: string;
  path?: string;
  mime?: string;
  bytes?: Uint8Array;
  sizeBytes?: number;
}): AttachmentSummary {
  const path = input.path?.trim();
  if (path && isSecretConfigPath(path)) {
    return {
      name: displayName(input),
      note: "secret configuration file omitted from summary",
    };
  }
  const mime = detectAttachmentMime(input);
  const sizeBytes = input.sizeBytes ?? input.bytes?.byteLength;
  const summary: AttachmentSummary = {
    name: displayName(input),
    ...(mime ? { mime } : {}),
    ...(sizeBytes !== undefined ? { sizeBytes } : {}),
  };
  if (input.bytes && mime?.startsWith("image/")) {
    const dims = extractImageDimensions(input.bytes, mime);
    if (dims) {
      summary.width = dims.width;
      summary.height = dims.height;
    }
  }
  return summary;
}
