// Channel upload limits for the P1/P2 send path. Discord and Telegram
// product wording stays the same; fake uses the generic harness cap.
// Metadata only — this is not a media product.

export interface ChannelUploadLimits {
  maxCount: number;
  maxBytes: number;
}

export interface ChannelAttachmentCandidate {
  id?: string;
  name: string;
  mime?: string;
  sizeBytes?: number;
}

export type ChannelUploadResult<T extends ChannelAttachmentCandidate = ChannelAttachmentCandidate> =
  | { ok: true; attachments: T[] }
  | { ok: false; error: string };

const DISCORD_LIMITS: ChannelUploadLimits = { maxCount: 10, maxBytes: 8 * 1024 * 1024 };
const TELEGRAM_LIMITS: ChannelUploadLimits = { maxCount: 10, maxBytes: 50 * 1024 * 1024 };
const FAKE_LIMITS: ChannelUploadLimits = { maxCount: 10, maxBytes: 8 * 1024 * 1024 };
const DEFAULT_LIMITS: ChannelUploadLimits = { maxCount: 10, maxBytes: 8 * 1024 * 1024 };

export const CHANNEL_UPLOAD_LIMITS = {
  discord: DISCORD_LIMITS,
  telegram: TELEGRAM_LIMITS,
  fake: FAKE_LIMITS,
} as const;

export function channelUploadLimits(kind: string): ChannelUploadLimits {
  if (kind === "discord") return { ...DISCORD_LIMITS };
  if (kind === "telegram") return { ...TELEGRAM_LIMITS };
  if (kind === "fake") return { ...FAKE_LIMITS };
  return { ...DEFAULT_LIMITS };
}

function channelLabel(kind: string): string {
  if (kind === "discord") return "Discord";
  if (kind === "telegram") return "Telegram";
  if (kind === "fake") return "fake channel";
  return kind;
}

export function enforceChannelUploadLimits<T extends ChannelAttachmentCandidate>(
  kind: string,
  attachments: T[] | undefined,
  limits: Partial<ChannelUploadLimits> = {},
): ChannelUploadResult<T> {
  const list = attachments ?? [];
  const defaults = channelUploadLimits(kind);
  const maxCount = limits.maxCount ?? defaults.maxCount;
  const maxBytes = limits.maxBytes ?? defaults.maxBytes;
  const label = channelLabel(kind);
  if (list.length > maxCount) {
    return { ok: false, error: `${label} allows at most ${maxCount} attachments per message` };
  }
  for (const item of list) {
    if (item.sizeBytes !== undefined && (item.sizeBytes < 0 || !Number.isFinite(item.sizeBytes))) {
      return { ok: false, error: `${label} attachment size is invalid` };
    }
    if ((item.sizeBytes ?? 0) > maxBytes) {
      return { ok: false, error: `${label} attachment "${item.name}" exceeds the ${maxBytes} byte limit` };
    }
  }
  return { ok: true, attachments: list };
}
