// Barrel for the P3 attachment-policy modules. Existing call sites can
// keep importing server/attachments.ts.

export {
  detectAttachmentMime,
  detectImageMediaType,
  detectMimeFromBytes,
  detectMimeFromName,
} from "./mime.ts";
export { extractImageDimensions, type ImageDimensions } from "./dimensions.ts";
export {
  attachmentPreviewDecision,
  attachmentPreviewExcerpt,
  type AttachmentPreviewDecision,
  type AttachmentPreviewKind,
} from "./preview.ts";
export { safeOpenAttachment, type SafeOpenDecision, type SafeOpenMode } from "./safe-open.ts";
export {
  CHANNEL_UPLOAD_LIMITS,
  channelUploadLimits,
  enforceChannelUploadLimits,
  type ChannelAttachmentCandidate,
  type ChannelUploadLimits,
  type ChannelUploadResult,
} from "./channel-limits.ts";
export { summarizeAttachment, type AttachmentSummary } from "./summary.ts";
export {
  DEFAULT_INLINE_MAX_BYTES,
  degradeIfOversized,
  isOversized,
  oversizedMetadataStub,
  type OversizedAttachmentStub,
} from "./oversized.ts";
export {
  assessRemoteAttachmentUrl,
  downloadRemoteAttachment,
  isBlockedLiteralAddress,
  type RemoteDownloadOptions,
  type RemoteDownloadResult,
  type RemoteUrlDecision,
  type RemoteUrlLookup,
  type RemoteUrlPolicyOptions,
} from "./remote-url.ts";
export {
  acpImageBlocks,
  agentAcceptsImagePrompts,
  attachmentPathRefs,
  claudeImageBlocks,
  codexImageInput,
  expandAttachmentPaths,
  isSecretConfigPath,
  readImageBytes,
  type CodexImageInput,
  type ImageBytes,
} from "./storage.ts";
