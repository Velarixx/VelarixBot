// Hermes Agent harness support — the `hermes` CLI over ACP stdio
// (`hermes … acp stdio`), on the ChatGPT subscription login
// (`hermes login` → HERMES_AUTH_FILE), never an OpenAI API key.
// The generic protocol runtime lives in acp/core.ts; this file is only the
// per-harness quirks, modeled on acp/grok.ts.
//
// Coordinator tier: agents/memory/composio/workspace MCP, the permission
// bridge, session/load, image gating, _meta usage, and interrupt all come
// from the ACP core. No third-party protocol translation.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { createAcpDriver, type AcpSupport } from "./core.ts";

// Where `hermes login` stores the ChatGPT OAuth credentials (mirrors Codex's
// ~/.codex/auth.json). Single source of truth for the signed-in probe — if
// the CLI ever moves the file, change this one constant.
const HERMES_AUTH_FILE = [".hermes", "auth.json"] as const;

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
  loginNote: "Hermes is not signed in to ChatGPT — run `hermes login` in a terminal, then retry.",

  // --approval-policy must always be explicit: a local Hermes config may set
  // auto-approve, which would silently make every session yolo and never
  // fire session/request_permission.
  spawnArgs: (config, turn) => [
    "--approval-policy",
    config.fullAuto ? "never" : "acp",
    ...(turn.model ? ["-m", turn.model] : []),
    "acp",
    "stdio",
  ],

  // The CLI owns its own ChatGPT login; a leaked API key silently flips
  // billing from the subscription to pay-as-you-go.
  transformEnv: (env) => {
    delete env.OPENAI_API_KEY;
    delete env.HERMES_API_KEY;
    delete env.HERMES_AUTH_JSON;
  },

  // Bind the ChatGPT subscription login. No API-key fallback by design —
  // an unauthenticated CLI is a user action, not something to paper over.
  pickAuthMethod: (methods) => methods.find((m) => m.id === "chatgpt-oauth")?.id ?? null,
  authFailure: "fail",
  isAuthenticated: () => existsSync(join(homedir(), ...HERMES_AUTH_FILE)),

  // buildPromptText omitted on purpose — the core default (persona prepended
  // codex-style) is the contract here.
};

export const HermesAgentDriver = createAcpDriver(support);
