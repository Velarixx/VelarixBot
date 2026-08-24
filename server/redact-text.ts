/** Strip values that look like keys/tokens before they hit disk, logs, or UI. */
export function redactSecrets(text: string): string {
  return text
    .replace(/\b(sk|xai|ghp|gho|github_pat|ak|ck|xoxb|xoxp|xoxa)-[A-Za-z0-9_-]+/gi, "$1-[redacted]")
    .replace(/\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/g, "[redacted-telegram-token]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\b(api[_-]?key|token|secret|password|passwd)\b\s*[:=]\s*\S+/gi, "$1=[redacted]");
}
