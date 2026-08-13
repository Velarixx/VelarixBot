// Credential-handoff helpers: strip secrets from the card copy and keep
// passwords/2FA out of the transcript.
import { redactSecrets } from "./approvals.ts";

export const HANDOFF_TITLE = "Bot needs you to sign in";
export const HANDOFF_CONTINUE = "I've signed in — continue";
export const HANDOFF_SUBTITLE =
  "Open the bot's desktop and complete the sign-in there. Passwords and codes stay on that screen — never type them in chat.";

export function sanitizeHandoffSummary(text: string): string {
  const redacted = redactSecrets(String(text ?? ""));
  return redacted
    .replace(/\b(password|passwd|otp|2fa|totp|pin|secret|token)\b\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .replace(/\b[\w.+-]+@[\w.-]+\.\w+\b/g, "[redacted-email]")
    .slice(0, 300);
}
