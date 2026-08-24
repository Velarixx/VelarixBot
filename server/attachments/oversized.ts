// Oversized-file degradation: drop inline bytes and keep a metadata stub.
// Never invent a gallery or embed file contents.

export const DEFAULT_INLINE_MAX_BYTES = 8 * 1024 * 1024;

export interface OversizedAttachmentStub {
  kind: "oversized-stub";
  name: string;
  mime?: string;
  sizeBytes: number;
  maxBytes: number;
  reason: string;
}

export function isOversized(sizeBytes: number, maxBytes = DEFAULT_INLINE_MAX_BYTES): boolean {
  return Number.isFinite(sizeBytes) && sizeBytes > maxBytes;
}

/** Metadata-only stub for a file that is too large to inline. */
export function oversizedMetadataStub(input: {
  name: string;
  mime?: string;
  sizeBytes: number;
  maxBytes?: number;
}): OversizedAttachmentStub {
  const maxBytes = input.maxBytes ?? DEFAULT_INLINE_MAX_BYTES;
  return {
    kind: "oversized-stub",
    name: input.name,
    ...(input.mime ? { mime: input.mime } : {}),
    sizeBytes: input.sizeBytes,
    maxBytes,
    reason: `File exceeds the ${maxBytes} byte inline limit; bytes were not loaded.`,
  };
}

export function degradeIfOversized(input: {
  name: string;
  mime?: string;
  sizeBytes: number;
  maxBytes?: number;
}): { oversized: false } | { oversized: true; stub: OversizedAttachmentStub } {
  const maxBytes = input.maxBytes ?? DEFAULT_INLINE_MAX_BYTES;
  if (!isOversized(input.sizeBytes, maxBytes)) return { oversized: false };
  return { oversized: true, stub: oversizedMetadataStub({ ...input, maxBytes }) };
}
