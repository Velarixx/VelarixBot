// Gemini CLI harness support — Google's `gemini` CLI over ACP stdio
// (`gemini --acp`). Rides the generic runtime in acp/core.ts.
//
// Verified end-to-end against a live gemini-cli 0.55.1 (2026-08-16):
//
// - The ACP flag is `--acp`; `--experimental-acp` still works but is
//   documented deprecated ("use --acp instead"), so we spawn the current
//   grammar. `--approval-mode default` composes with `--acp` and is passed
//   EXPLICITLY so a user's settings.json approval mode (auto_edit / yolo)
//   can never silently bypass session/request_permission. fullAuto rides
//   the ACP permission bridge in core.ts (audited, per-ask) and NEVER maps
//   to `--yolo` / `--approval-mode yolo` — P0.1: no approval below the
//   permission broker.
//
// - initialize advertises authMethods (oauth-personal, gemini-api-key,
//   vertex-ai, gateway) UNCONDITIONALLY — even on a machine with zero
//   credentials — so method presence is not an auth signal, and the ACP
//   `authenticate` RPC is NOT a login check: it *selects* a method, which
//   PERSISTS security.auth.selectedType into the user's ~/.gemini/
//   settings.json and — when it differs from the current selection — CLEARS
//   the cached OAuth credential file. A driver that authenticates with its
//   own preference would delete a user's "Log in with Google" session and
//   flip their configured auth method as a side effect of running a turn.
//   So pickAuthMethod returns null: session/new derives auth from the
//   user's own settings + env, exactly like an interactive `gemini` run.
//
// - The real signed-out signal is session/new failing with ACP
//   auth_required (-32000, e.g. "Gemini API key is missing or not
//   configured."), which core.ts already maps to a clean auth_required
//   settle carrying loginNote. A machine with selectedType=oauth-personal
//   but no cached creds instead HANGS session/new on an interactive OAuth
//   flow; NO_BROWSER (below) keeps that from popping a browser out of a
//   headless bot turn, and core's session timeout settles it.
//
// - There is no `gemini login` / `gemini auth` command — signing in is
//   running `gemini` interactively (or the /auth slash command), or setting
//   GEMINI_API_KEY. The login copy names those, nothing invented.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { cliExec } from "../cli.ts";
import { createAcpDriver, type AcpSupport } from "./core.ts";

// Where gemini-cli keeps its user-scope state. settings.json's
// security.auth.selectedType is written by every completed auth flow;
// oauth_creds.json is the cached "Log in with Google" credential.
const GEMINI_DIR = join(homedir(), ".gemini");

/** The auth method the user themselves configured (nested current schema,
 * with the pre-migration flat key as fallback); undefined when never set. */
function selectedAuthType(): string | undefined {
  try {
    const raw = JSON.parse(readFileSync(join(GEMINI_DIR, "settings.json"), "utf8")) as {
      security?: { auth?: { selectedType?: unknown } };
      selectedAuthType?: unknown;
    };
    const nested = raw.security?.auth?.selectedType;
    if (typeof nested === "string") return nested;
    return typeof raw.selectedAuthType === "string" ? raw.selectedAuthType : undefined;
  } catch {
    return undefined;
  }
}

const support: AcpSupport = {
  driverKind: "geminiAgent",
  displayName: "Gemini",
  // What a live gemini-cli 0.55.1 advertised in session/new's
  // models.availableModels (probed 2026-08-16) — the ids are the CLI's own
  // modelIds verbatim, "auto" is ITS default (currentModelId with no -m).
  // This is a dated fallback for the picker, not the runtime truth: the
  // session.started event reports whatever currentModelId the CLI actually
  // advertises for the session (core.ts), so a CLI-side catalog change is
  // visible per turn even before this list is re-probed.
  models: {
    default: "auto",
    options: [
      { id: "auto", label: "Auto (Gemini CLI picks)" },
      { id: "gemini-3.1-pro-preview-customtools", label: "Gemini 3.1 Pro Preview" },
      { id: "gemini-3-flash-preview", label: "Gemini 3 Flash Preview" },
      { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
      { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash" },
      { id: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash Lite" },
    ],
  },
  defaultCli: "gemini",
  nativeSource: "gemini.acp",
  // Never a `gemini login` — no such command exists (0.55.1's commands are
  // mcp/extensions/skills/hooks/gemma). Sign-in is the interactive CLI or
  // an API key.
  loginNote:
    "Gemini CLI is not signed in — run `gemini` in a terminal and complete " +
    "\u201cLog in with Google\u201d (or the /auth command), or set GEMINI_API_KEY",

  // `--approval-mode default` is always explicit: settings.json can set a
  // default approval mode of auto_edit/yolo, which would silently make every
  // session self-approving and never fire session/request_permission.
  spawnArgs: (_config, turn) => [
    "--acp",
    "--approval-mode",
    "default",
    ...(turn.model ? ["-m", turn.model] : []),
  ],

  // A revoked/absent Google login makes the CLI start an interactive OAuth
  // flow inside session/new; without this it opens a browser window out of
  // a headless bot turn. With it the CLI prints the auth URL and waits,
  // which core's session timeout settles. GEMINI_API_KEY is deliberately
  // NOT stripped — the API key is a first-class auth path here, not a
  // billing bypass like grok/hermes.
  transformEnv: (env) => {
    env.NO_BROWSER = "true";
  },

  // Never authenticate: gemini's authenticate RPC persists the method into
  // the user's settings.json and clears the cached OAuth creds on a method
  // switch (verified against 0.55.1) — a turn must not rewrite the user's
  // login. session/new authenticates off the user's own settings + env and
  // fails with -32000 when signed out, which maps to loginNote.
  pickAuthMethod: () => null,
  authFailure: "continue",

  // Sign-in heuristic for snapshot(), keyed on the auth method the USER
  // selected (~/.gemini/settings.json), mirroring how session/new resolves
  // it. Tri-state: undefined = unknown, never a fabricated "signed out" —
  // vertex/gateway credentials (ADC, custom gateways) and .env-file-seeded
  // API keys are not probeable from one file.
  isAuthenticated: (env) => {
    const selected = selectedAuthType();
    if (selected === "oauth-personal") return existsSync(join(GEMINI_DIR, "oauth_creds.json"));
    if (selected === "vertex-ai") {
      // GOOGLE_API_KEY is the Vertex express key; ADC setups are unknowable
      return env.GOOGLE_API_KEY || (env.GOOGLE_CLOUD_PROJECT && env.GOOGLE_CLOUD_LOCATION) ? true : undefined;
    }
    if (selected === "gateway") return undefined;
    // gemini-api-key selected, or nothing selected (the CLI falls back to
    // the API key path). GOOGLE_API_KEY alone does NOT satisfy it —
    // verified: session/new still fails "Gemini API key is missing".
    if (env.GEMINI_API_KEY) return true;
    // the CLI also loads GEMINI_API_KEY from .env files we don't parse
    if (existsSync(join(GEMINI_DIR, ".env")) || existsSync(join(homedir(), ".env"))) return undefined;
    return false;
  },

  buildPromptText: (turn) => (turn.system ? `${turn.system}\n\n${turn.text}` : turn.text),

  // One-shot text (bot titles, memory distill) via the CLI's headless mode
  // (`gemini -p <prompt>`). Same env as turns; hard 60s cap.
  generateText: async (config, env, prompt) => {
    const result = await cliExec(config.cli, ["-p", prompt], {
      timeout: 60_000,
      env: env as NodeJS.ProcessEnv,
    });
    if (!result.ok) throw new Error(result.stderr.trim() || `\`${config.cli}\` -p failed`);
    return result.stdout.trim();
  },
};

export const GeminiAgentDriver = createAcpDriver(support);
