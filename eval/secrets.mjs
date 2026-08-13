// Presence-only secret detection for the Playwright eval.
// Required: Claude + Codex. Grok/xAI and Hermes are optional and never gate
// the run. Never log, return, or write secret values — only booleans and names.

// Names already used on Velarixx/VelarixBot (issue #39 + OpenAI Codex CI docs).
// Values stay in Actions secrets — this file only knows the names.
export const SECRET_NAMES = Object.freeze({
  claude: "CLAUDE_CODE_OAUTH_TOKEN",
  codex: "CODEX_AUTH_JSON",
  grok: "XAI_API_KEY",
  // full ~/.hermes/auth.json contents (`hermes login` output) — optional
  hermes: "HERMES_AUTH_JSON",
});

function present(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/** Same Codex check the eval/canary gates use. MCP on-request must call this
 * — not a HOME-only seed, alias env, or a different secret name. */
export function codexSecretPresent(env = process.env) {
  return present(env[SECRET_NAMES.codex]);
}

/** Which provider secrets are set. Values are never included.
 * `ready` is Claude or Codex — Grok or Hermes alone never open the gate. */
export function detectSecrets(env = process.env) {
  const claude = present(env[SECRET_NAMES.claude]);
  const codex = codexSecretPresent(env);
  const grok = present(env[SECRET_NAMES.grok]);
  const hermes = present(env[SECRET_NAMES.hermes]);
  return { claude, codex, grok, hermes, ready: claude || codex };
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
    `hermes (${SECRET_NAMES.hermes}): ${found.hermes ? "configured (optional)" : "absent (optional — never required)"}`,
  ].join("\n");
}

export function skipMessage() {
  return [
    "Skipping Playwright eval: no Claude or Codex secrets configured.",
    "Expected secret names (values are human-owned; never commit them):",
    `  ${SECRET_NAMES.claude}  — Claude CLI OAuth (claude setup-token)`,
    `  ${SECRET_NAMES.codex}         — full ~/.codex/auth.json contents`,
    "Grok / xAI is not required and is skipped unless that secret is already present.",
    `Hermes is not required and is skipped unless ${SECRET_NAMES.hermes} is already present.`,
    "Exit 0 so CI stays green without secrets.",
  ].join("\n");
}
