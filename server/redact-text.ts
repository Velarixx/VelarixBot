/** Strip values that look like keys/tokens before they hit disk, logs, or UI. */
const MIN_REGISTERED_SECRET = 8;
const registeredSecrets = new Set<string>();

export function rememberSecretValues(values: Iterable<string>): void {
  for (const value of values) {
    if (typeof value === "string" && value.length >= MIN_REGISTERED_SECRET) registeredSecrets.add(value);
  }
}

export function forgetSecretValues(values?: Iterable<string>): void {
  if (!values) {
    registeredSecrets.clear();
    return;
  }
  for (const value of values) registeredSecrets.delete(value);
}

export function replaceBitwardenSecretValues(values: Iterable<string>): void {
  forgetSecretValues();
  rememberSecretValues(values);
}

export function clearBitwardenSecretValues(): void {
  forgetSecretValues();
}

export function redactRegisteredSecrets(text: string): string {
  let out = text;
  for (const secret of registeredSecrets) {
    if (secret && out.includes(secret)) out = out.split(secret).join("[redacted]");
  }
  return out;
}

export function redactSecrets(text: string): string {
  return redactRegisteredSecrets(
    text
      .replace(/\b(sk|xai|ghp|gho|github_pat|ak|ck|xoxb|xoxp|xoxa)-[A-Za-z0-9_-]+/gi, "$1-[redacted]")
      .replace(/\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/g, "[redacted-telegram-token]")
      .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
      .replace(/\b(api[_-]?key|token|secret|password|passwd)\b\s*[:=]\s*\S+/gi, "$1=[redacted]"),
  );
}
