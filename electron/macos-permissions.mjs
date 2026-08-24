// Least-privilege macOS TCC policy. Prompts are feature-gated — never at
// launch or on a text chat turn. Apple Music is not a VelarixBot feature.
export const USAGE_DESCRIPTIONS = {
  NSMicrophoneUsageDescription:
    "VelarixBot uses the microphone only when you start voice dictation in the composer.",
  NSSpeechRecognitionUsageDescription:
    "VelarixBot transcribes your voice on-device when you start dictation, so it can type the message for you.",
  NSAccessibilityUsageDescription:
    "VelarixBot needs Accessibility when you ask a bot to control this Mac — clicks, typing, and window actions.",
  NSScreenCaptureUsageDescription:
    "VelarixBot needs Screen Recording when you open This Mac or ask a bot to see the screen you told it to use.",
};

export const FORBIDDEN_USAGE_KEYS = [
  "NSAppleMusicUsageDescription",
  "NSMusicUsageDescription",
];

export const FORBIDDEN_ENTITLEMENTS = [
  "com.apple.security.personal-information.music",
  "com.apple.security.assets.music.read-write",
  "com.apple.security.assets.music.read-only",
];

export const LAUNCH_FORBIDDEN_REQUESTS = [
  "microphone",
  "camera",
  "screen",
  "accessibility",
  "apple-music",
  "media-library",
  "speech",
];

export const FEATURE_PERMISSIONS = {
  dictation: ["microphone", "speech"],
  localComputerPreview: ["screen"],
  localComputerControl: ["accessibility", "screen"],
  appleMusic: ["apple-music"],
};

export function permissionForFeature(feature) {
  return FEATURE_PERMISSIONS[feature] ?? [];
}

export function shouldRequestAtLaunch(permission) {
  return !LAUNCH_FORBIDDEN_REQUESTS.includes(permission);
}

export function appleMusicAllowed(feature) {
  return feature === "appleMusic";
}
