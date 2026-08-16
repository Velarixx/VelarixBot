// Hermes Agent harness support — the `hermes` CLI over ACP stdio
// (`hermes [-m <model>] acp`, verified against v0.20.1), on the ChatGPT
// subscription login (`hermes login` → HERMES_AUTH_FILE), never an OpenAI
// API key.
// The generic protocol runtime lives in acp/core.ts; this file is only the
// per-harness quirks, modeled on acp/grok.ts.
//
// Coordinator tier: agents/memory/composio/workspace MCP, the permission
// bridge, session/load, image gating, _meta usage, and interrupt all come
// from the ACP core. No third-party protocol translation.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { cliExec } from "../cli.ts";
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

  // v0.20.1 grammar: global `-m <model>` before the bare `acp` subcommand —
  // there is no `--approval-policy` flag and no trailing `stdio` (that argv
  // is rejected with usage + exit 2, the rc.14 field grey-out). Approvals
  // ride ACP session/request_permission, where the core answers fail-closed;
  // fullAuto auto-allows at that bridge (audited, per-ask) and deliberately
  // never maps to the CLI's global `--yolo` bypass — P0.1: a turn must not
  // silently auto-approve below the permission bridge.
  spawnArgs: (_config, turn) => [...(turn.model ? ["-m", turn.model] : []), "acp"],

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
