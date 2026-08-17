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

import type { ModelCatalog } from "../../contracts.ts";
import { cliExec, killProcessTree, spawnCliHidden } from "../cli.ts";
import { catalogFromAvailableModels } from "./catalog.ts";
import { createAcpDriver, type AcpConfig, type AcpSupport } from "./core.ts";

// Where gemini-cli keeps its user-scope state. settings.json's
// security.auth.selectedType is written by every completed auth flow;
// oauth_creds.json is the cached "Log in with Google" credential.
const GEMINI_DIR = join(homedir(), ".gemini");

// The auth method ids a live gemini-cli 0.55.1 advertises in
// initialize.authMethods (verified 2026-08-16) — the historical trio plus
// the newer gateway method. Advertised UNCONDITIONALLY, signed in or not,
// so presence is not an auth signal; pinned here (and against the live CLI
// in gemini.test.ts) so a rename shows up as a test failure, not a guess.
export const GEMINI_AUTH_METHOD_IDS = ["oauth-personal", "gemini-api-key", "vertex-ai", "gateway"] as const;

/** First-class Gemini auth paths — the API key is not a billing bypass
 *  here (unlike grok/hermes). Vertex express uses GOOGLE_API_KEY. */
export const GEMINI_CREDENTIAL_ENV = ["GEMINI_API_KEY", "GOOGLE_API_KEY"] as const;

// ACP-mode argv verified live against 0.55.1: `--acp` is the current flag
// (`--experimental-acp` still works but is documented deprecated), and
// `--approval-mode default` + `-m <model>` compose with it (`-m` confirmed
// to set the session's models.currentModelId).
const ACP_ARGS = ["--acp", "--approval-mode", "default"];

const ACP_AUTH_REQUIRED_CODE = -32000;
const AUTH_PROBE_TIMEOUT = 8_000;

/** Ask the CLI itself whether it is signed in: spawn the exact ACP argv a
 * turn uses, initialize, then attempt session/new — gemini's real login
 * gate (verified against 0.55.1: it fails with ACP auth_required -32000
 * when no usable credential resolves, and succeeds without any network
 * validation when one does). true/false only on a conclusive answer; a
 * non-auth error, a spawn failure, or a timeout — the signed-out-OAuth
 * shape hangs session/new on an interactive login flow — resolve undefined
 * so the disk/env heuristic below stays the fallback. */
type SessionProbe = { authenticated: boolean | undefined; models: ModelCatalog | null };

/** One initialize + session/new: auth gate AND models.availableModels.
 * Shared by probeAuthenticated and resolveModels so a cache refresh is
 * one spawn, not two. In-flight calls with the same cli+mode coalesce. */
const sessionProbes = new Map<string, Promise<SessionProbe>>();

function probeSession(config: AcpConfig, env: Record<string, string | undefined>): Promise<SessionProbe> {
  const key = `${config.cli}\0${env.FAKE_ACP_MODE ?? ""}\0${env.FAKE_ACP_SESSION_MODELS ?? ""}\0${env.FAKE_GEMINI_AUTH ?? ""}`;
  const hit = sessionProbes.get(key);
  if (hit) return hit;
  const pending = new Promise<SessionProbe>((resolve) => {
    let child: ReturnType<typeof spawnCliHidden>;
    try {
      child = spawnCliHidden(config.cli, ACP_ARGS, {
        env: env as NodeJS.ProcessEnv,
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
      });
    } catch {
      return resolve({ authenticated: undefined, models: null });
    }
    let done = false;
    const finish = (v: SessionProbe) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      killProcessTree(child.pid);
      resolve(v);
    };
    const timer = setTimeout(() => finish({ authenticated: undefined, models: null }), AUTH_PROBE_TIMEOUT);
    timer.unref?.();
    const send = (obj: unknown) => {
      try {
        child.stdin.write(JSON.stringify(obj) + "\n");
      } catch {
        /* stream gone — close/timeout resolves */
      }
    };
    let buf = "";
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let msg: { id?: unknown; result?: unknown; error?: { code?: unknown } };
        try {
          msg = JSON.parse(line);
        } catch {
          continue; // stderr-grade noise on stdout — keep reading
        }
        if (msg.id === 1) {
          send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: homedir(), mcpServers: [] } });
        } else if (msg.id === 2) {
          if (msg.result !== undefined) {
            return finish({ authenticated: true, models: catalogFromAvailableModels(msg.result) });
          }
          return finish({
            authenticated: msg.error?.code === ACP_AUTH_REQUIRED_CODE ? false : undefined,
            models: null,
          });
        }
      }
    });
    child.on("error", () => finish({ authenticated: undefined, models: null }));
    child.stdin.on("error", () => {
      /* close/timeout resolves */
    });
    child.on("close", () => finish({ authenticated: undefined, models: null }));
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } },
    });
  }).finally(() => {
    setTimeout(() => sessionProbes.delete(key), 1_000).unref?.();
  });
  sessionProbes.set(key, pending);
  return pending;
}

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
  // This is a dated fallback for the picker, not the runtime truth.
  // [VERIFY] 2026-08-17: live gemini-cli advertises models.availableModels
  // on session/new (FAKE_ACP_SESSION_MODELS in fakes). resolveModels
  // refreshes instance.models on the identity-cache cadence so describe()
  // is not stuck on these create-time constants.
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
  spawnArgs: (_config, turn) => [...ACP_ARGS, ...(turn.model ? ["-m", turn.model] : [])],

  // A revoked/absent Google login makes the CLI start an interactive OAuth
  // flow inside session/new; without this it opens a browser window out of
  // a headless bot turn. With it the CLI prints the auth URL and waits,
  // which core's session timeout settles. GEMINI_API_KEY is deliberately
  // NOT stripped — the API key is a first-class auth path here, not a
  // billing bypass like grok/hermes. Opt in via credentialEnv so the core
  // deny-by-default allowlist keeps them; transformEnv only adds NO_BROWSER.
  credentialEnv: GEMINI_CREDENTIAL_ENV,
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

  // Sign-in truth for snapshot(): ASK THE CLI — attempt the same
  // session/new gate a turn rides (Hermes-style: the CLI's own answer, not
  // a file). Runs on identity-cache refresh only; the cache key still
  // carries the isAuthenticated hint, so a login that touches the disk/env
  // signature re-probes immediately instead of waiting out the 60s TTL.
  probeAuthenticated: async (config, env) => (await probeSession(config, env)).authenticated,
  // [VERIFY] 2026-08-17: catalog is session/new models.availableModels.
  // Same spawn as the auth probe (coalesced). No keys on argv.
  resolveModels: async (config, env) => (await probeSession(config, env)).models,

  // FALLBACK heuristic only — used when the CLI probe is inconclusive
  // (non-auth session error, or the signed-out-OAuth interactive hang).
  // Keyed on the auth method the USER selected (~/.gemini/settings.json),
  // mirroring how session/new resolves it. Tri-state: undefined = unknown,
  // never a fabricated "signed out" — vertex/gateway credentials (ADC,
  // custom gateways) and .env-file-seeded API keys are not probeable from
  // one file.
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
