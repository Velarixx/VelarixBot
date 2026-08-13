// Presence-only secret detection for the Playwright eval.
// Required: Claude + Codex. Grok/xAI is optional and never gates the run.
// Never log, return, or write secret values — only booleans and names.

export const SECRET_NAMES = Object.freeze({
  claude: "CLAUDE_CODE_OAUTH_TOKEN",
  codex: "CODEX_AUTH_JSON",
  grok: "XAI_API_KEY",
});

function present(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/** Which provider secrets are set. Values are never included.
 * `ready` is Claude or Codex — Grok alone does not open the gate. */
export function detectSecrets(env = process.env) {
  const claude = present(env[SECRET_NAMES.claude]);
  const codex = present(env[SECRET_NAMES.codex]);
  const grok = present(env[SECRET_NAMES.grok]);
  return { claude, codex, grok, ready: claude || codex };
}

/** Secret strings for redaction only — do not log or persist this list. */
export function secretValues(env = process.env) {
  return Object.values(SECRET_NAMES)
    .map((name) => env[name])
    .filter((value) => present(value));
}

export function formatPresence(found) {
  return [
    `claude (${SECRET_NAMES.claude}): ${found.claude ? "configured" : "absent"}`,
    `codex (${SECRET_NAMES.codex}): ${found.codex ? "configured" : "absent"}`,
    `grok (${SECRET_NAMES.grok}): ${found.grok ? "configured (optional)" : "absent (optional — never required)"}`,
  ].join("\n");
}

export function skipMessage() {
  return [
    "Skipping Playwright eval: no Claude or Codex secrets configured.",
    "Expected secret names (values are human-owned; never commit them):",
    `  ${SECRET_NAMES.claude}  — Claude CLI OAuth (claude setup-token)`,
    `  ${SECRET_NAMES.codex}         — full ~/.codex/auth.json contents`,
    "Grok / xAI is not required and is skipped unless that secret is already present.",
    "Exit 0 so CI stays green without secrets.",
  ].join("\n");
}
