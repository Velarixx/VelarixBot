// Credential-handoff helpers: detect a sign-in ask, strip secrets from
// the card copy, and keep passwords/2FA out of the transcript. Pure —
// no fs — so the chat UI can reuse the desktop-offer gate.
export const HANDOFF_TITLE = "Bot needs you to sign in";
export const HANDOFF_CONTINUE = "I've signed in — continue";
export const HANDOFF_SUBTITLE =
  "Open the bot's desktop and complete the sign-in there. Passwords and codes stay on that screen — never type them in chat.";
export const HANDOFF_SUBTITLE_LOCAL =
  "Complete the sign-in on this computer. Passwords and codes stay on that screen — never type them in chat.";

export type RequestType = "permission" | "question" | "credential";

export function isCredentialAsk(kind: string, tool: string, summary: string): boolean {
  const hay = `${kind} ${tool} ${summary}`;
  return /sign.?in|log.?in|credential|handoff|takeover|2fa|password|otp/i.test(hay);
}

export function sanitizeHandoffSummary(text: string): string {
  const redacted = String(text ?? "")
    .replace(/\b(sk|xai|ghp|gho|github_pat|ak|ck|xoxb|xoxp|xoxa)-[A-Za-z0-9_-]+/gi, "$1-[redacted]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\b(api[_-]?key|token|secret|password|passwd)\b\s*[:=]\s*\S+/gi, "$1=[redacted]");
  return redacted
    .replace(/\b(password|passwd|otp|2fa|totp|pin|secret|token)\b\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .replace(/\b[\w.+-]+@[\w.-]+\.\w+\b/g, "[redacted-email]")
    .slice(0, 300);
}

/** Classify a provider ask. Sign-in language becomes credential even when
 * the CLI only knows permission/question. */
export function classifyOpenedRequest(
  kind: string,
  tool: string,
  summary: string,
  choices?: string[],
): { requestType: RequestType; summary: string; choices?: string[] } {
  const credential = kind === "credential" || isCredentialAsk(kind, tool, summary);
  if (credential) {
    return {
      requestType: "credential",
      summary: sanitizeHandoffSummary(summary),
      choices: choices?.length ? choices.slice(0, 5) : [HANDOFF_CONTINUE],
    };
  }
  const requestType: RequestType = kind === "question" ? "question" : "permission";
  return {
    requestType,
    summary,
    ...(choices?.length ? { choices: choices.slice(0, 5) } : {}),
  };
}

/** A bot.computer binding that points at a REMOTE computer provider —
 * anything that is not off/local/unset ("cloud" is the legacy alias for the
 * bundled box binding). */
export function isRemoteComputerBinding(computer: string | undefined): boolean {
  return Boolean(computer) && computer !== "local" && computer !== "off";
}

export function handoffSubtitle(computer?: string): string {
  return isRemoteComputerBinding(computer) ? HANDOFF_SUBTITLE : HANDOFF_SUBTITLE_LOCAL;
}

/** Open desktop talks to the computer join endpoint — only when this bot is
 * bound to a configured remote computer. Local/off bots skip it. */
export function shouldOfferDesktop(computer: string | undefined, configured: boolean): boolean {
  return isRemoteComputerBinding(computer) && configured === true;
}
