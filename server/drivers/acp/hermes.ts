// Hermes Agent harness support — the `hermes` CLI over ACP stdio
// (`hermes [-m <model>] acp`, verified against v0.20.1), on Hermes' own
// credential pool (`hermes auth`; openai-codex OAuth is the ChatGPT/Codex
// subscription path), never an OpenAI API key.
// The generic protocol runtime lives in acp/core.ts; this file is only the
// per-harness quirks, modeled on acp/grok.ts.
//
// Coordinator tier: agents/memory/composio/workspace MCP, the permission
// bridge, session/load, image gating, _meta usage, and interrupt all come
// from the ACP core. No third-party protocol translation.
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { cliExec } from "../cli.ts";
import { createAcpDriver, type AcpSupport } from "./core.ts";

// Hermes' credential-pool store (`hermes auth` persists pool state under the
// credential_pool key here). NOT a sign-in gate: credentials can be
// env-seeded, imported (~/.codex/auth.json, Claude Code), profile-scoped
// (~/.hermes/profiles/<name>/auth.json), or supplied entirely by a secret
// manager — the Bitwarden Secrets Manager integration hydrates provider
// keys into the process env at every hermes start ("Bitwarden Secrets
// Manager: applied N secrets"), leaving NOTHING under ~/.hermes (the field
// machine has only ~/.hermes/plans/ while `hermes auth` lists openai-codex
// oauth creds). So this file's absence proves nothing — requiring it is
// exactly the v0.20.1 field failure ("run `hermes login`" on an
// authenticated machine; that command no longer even exists). The path is
// only a cheap change signal that busts the snapshot identity cache the
// moment `hermes auth …` rewrites the store; when creds never touch disk
// the hint is a constant "absent" and the 60s TTL is the refresh path. The
// signed-in truth is the ACP handshake itself (authenticatedFromInit).
const HERMES_AUTH_STORE = [".hermes", "auth.json"] as const;

// The terminal setup method Hermes ACP always advertises (launches
// `hermes --setup` out of band) — even on a machine with zero credentials,
// so its presence proves nothing about auth.
const TERMINAL_SETUP_METHOD = "hermes-setup";

// Hermes advertises the resolved runtime provider (openai-codex for the
// ChatGPT/Codex subscription, or whatever `hermes model` configured) as an
// agent-managed auth method id if and only if its credential pool resolves
// usable credentials. Filter by BOTH the fixed setup id and the terminal
// type, so a future terminal-flavored method never reads as signed-in.
const usableAuthMethod = (methods: Array<{ id?: string; type?: string }>) =>
  methods.find((m) => typeof m.id === "string" && m.id !== TERMINAL_SETUP_METHOD && m.type !== "terminal");

const support: AcpSupport = {
  driverKind: "hermesAgent",
  displayName: "Hermes",
  // Static v1 catalog; eventually read from the initialize result's
  // _meta.modelState once the CLI advertises one.
  models: {
    default: "gpt-5.6-sol",
    options: [
      { id: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
      { id: "gpt-5.5", label: "GPT-5.5" },
    ],
  },
  defaultCli: "hermes",
  nativeSource: "hermes.acp",
  // Never `hermes login` — v0.20.1 removed that command. `hermes auth`
  // manages the credential pool; `hermes setup` is the guided flow.
  loginNote:
    "Hermes has no usable provider credentials — add one with `hermes auth` " +
    "(ChatGPT/Codex subscription: `hermes auth add openai-codex`) or run `hermes setup`, then retry.",

  // v0.20.1 grammar: global `-m <model>` before the bare `acp` subcommand —
  // there is no `--approval-policy` flag and no trailing `stdio` (that argv
  // is rejected with usage + exit 2, the rc.14 field grey-out). Approvals
  // ride ACP session/request_permission, where the core answers fail-closed;
  // fullAuto auto-allows at that bridge (audited, per-ask) and deliberately
  // never maps to the CLI's global `--yolo` bypass — P0.1: a turn must not
  // silently auto-approve below the permission bridge.
  spawnArgs: (_config, turn) => [...(turn.model ? ["-m", turn.model] : []), "acp"],

  // The CLI owns its own credential pool; a leaked API key silently flips
  // billing from the subscription to pay-as-you-go.
  transformEnv: (env) => {
    delete env.OPENAI_API_KEY;
    delete env.HERMES_API_KEY;
    delete env.HERMES_AUTH_JSON;
  },

  // Bind the agent-managed pool credential Hermes advertises: prefer
  // openai-codex (the ChatGPT/Codex subscription), else whatever provider
  // the pool resolved — Hermes only accepts authenticate for the provider
  // it advertised, so the advertised id IS the valid one. Never the
  // terminal setup method: picking it can acknowledge a login that does
  // not exist yet. No API-key fallback by design — an unconfigured CLI is
  // a user action (`hermes auth` / `hermes setup`), not something to paper
  // over. When only the setup method is advertised (no pool credentials),
  // this returns null and the turn fails closed with loginNote.
  pickAuthMethod: (methods) =>
    (methods.find((m) => m.id === "openai-codex") ?? usableAuthMethod(methods))?.id ?? null,
  authFailure: "fail",

  // Signed-in truth = the ACP handshake: Hermes advertises an agent-managed
  // auth method exactly when its credential pool resolves. No filesystem
  // probe — the pool store's location and shape are the CLI's business.
  authenticatedFromInit: (init) => {
    const methods = (init as { authMethods?: unknown } | null)?.authMethods;
    return usableAuthMethod(Array.isArray(methods) ? methods : []) !== undefined;
  },
  // …but a store rewrite must re-probe immediately (`hermes auth add`
  // un-greys the picker on the next describe(), not after the 60s TTL).
  authCacheHint: () => {
    try {
      const s = statSync(join(homedir(), ...HERMES_AUTH_STORE));
      return `${s.mtimeMs}:${s.size}`;
    } catch {
      return "absent";
    }
  },

  // buildPromptText omitted on purpose — the core default (persona prepended
  // codex-style) is the contract here.

  // One-shot text (bot titles, memory distill) via the CLI's non-interactive
  // mode. Same key-hygiene env as turns; hard 60s cap.
  generateText: async (config, env, prompt) => {
    const result = await cliExec(config.cli, ["exec", "-p", prompt], {
      timeout: 60_000,
      env: env as NodeJS.ProcessEnv,
    });
    if (!result.ok) throw new Error(result.stderr.trim() || `\`${config.cli}\` exec failed`);
    return result.stdout.trim();
  },
};

export const HermesAgentDriver = createAcpDriver(support);
