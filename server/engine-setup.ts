// Engine-unavailable UX: never show a raw machine stopReason (spawn_error)
// as user-facing stateDetail. Keep the code on stateCode; put the actual
// snapshot/unavailable reason in stateDetail; append a setup/switch-model
// card so a missing CLI is actionable instead of a hang.
//
// [VERIFY] 2026-08-18: drivers settle missing binaries as stopReason
// "spawn_error" (claude.ts / codex.ts / acp/core.ts). turns.ts used to
// write that string straight onto BotRecord.stateDetail, which ChatView
// renders as the blocked banner. Snapshot.reason already names the CLI
// (`\`claude\` CLI not found`). Zero available engines must not spawn.

import { existsSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

import { augmentedPath } from "./env-path.ts";
import { COLORS, type MausColor, type OptionCardData } from "./store.ts";

/** Test-only PATH for cliMissing. Production always uses augmentedPath(). */
let cliSearchPathOverride: string | undefined;

export function setCliSearchPathForTests(path: string | undefined): void {
  cliSearchPathOverride = path;
}

export function cliSearchPath(): string {
  return cliSearchPathOverride ?? augmentedPath();
}

function findOnPath(name: string, pathEnv: string): boolean {
  const names =
    process.platform === "win32"
      ? [name, `${name}.exe`, `${name}.cmd`, `${name}.bat`, `${name}.com`]
      : [name];
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    for (const candidate of names) {
      try {
        if (existsSync(join(dir, candidate))) return true;
      } catch {
        /* unreadable PATH entry */
      }
    }
  }
  return false;
}

/** Sync pre-spawn check. API/fake instances (no cli) are spawnable so #98
 * drain still calls sendTurn on the same tick. Absolute/relative paths use
 * existsSync. Bare names (`claude`) walk PATH — including augmentedPath
 * so a GUI launch still finds ~/.local/bin. */
export function cliMissing(cli: string | undefined | null, pathEnv: string = cliSearchPath()): boolean {
  if (!cli) return false;
  if (isAbsolute(cli) || /[\\/]/.test(cli)) return !existsSync(cli);
  return !findOnPath(cli, pathEnv);
}

/** @deprecated use cliMissing — kept for a release so older tests compile. */
export function absoluteCliMissing(cli: string | undefined | null): boolean {
  return cliMissing(cli);
}

/** Machine-readable turn stop / block codes. Never copy these into
 * user-facing stateDetail. */
export const ENGINE_STATE_CODES = [
  "spawn_error",
  "auth_required",
  "no_engines",
  "engine_unavailable",
] as const;
export type EngineStateCode = (typeof ENGINE_STATE_CODES)[number];

export const SETUP_ENGINE_OPTIONS = [
  "Install Claude Code: `npm i -g @anthropic-ai/claude-code`, then run `claude` to sign in",
  "Install Codex: `npm i -g @openai/codex`, then run `codex` to sign in",
  "Install Grok: see https://x.ai/cli, then run `grok login`",
  "Install Gemini CLI, then run `gemini` and complete “Log in with Google” (or set GEMINI_API_KEY)",
] as const;

export const SWITCH_MODEL_OPTION = "Switch model in Settings";

const MACHINE_CODE = /^[a-z][a-z0-9_]*$/;

export function isMachineStateCode(value: string | null | undefined): boolean {
  if (!value) return false;
  return MACHINE_CODE.test(value);
}

export function isSpawnFailure(stopReason?: string | null, runtimeMessage?: string | null): boolean {
  if (stopReason === "spawn_error") return true;
  return typeof runtimeMessage === "string" && /^spawn failed\b/i.test(runtimeMessage);
}

/** Reject empty / whitespace-only names. Trim a usable name. */
export function normalizeBotName(value: unknown): { ok: true; name: string } | { ok: false; error: string } {
  if (typeof value !== "string") return { ok: false, error: "name must be a string" };
  const name = value.trim();
  if (!name) return { ok: false, error: "name cannot be empty" };
  return { ok: true, name };
}

export function normalizeBotColor(value: unknown): MausColor | null {
  return typeof value === "string" && (COLORS as readonly string[]).includes(value) ? (value as MausColor) : null;
}

export function engineSetupCard(opts: {
  reason: string;
  /** When at least one other engine might work, lead with switch-model. */
  offerSwitch?: boolean;
  zeroEngines?: boolean;
}): OptionCardData {
  const title = opts.zeroEngines ? "Set up a local engine" : "This engine is not available";
  const options = opts.offerSwitch && !opts.zeroEngines
    ? [SWITCH_MODEL_OPTION, ...SETUP_ENGINE_OPTIONS]
    : [...SETUP_ENGINE_OPTIONS];
  return {
    title,
    subtitle: opts.reason,
    options,
    requestType: "setup",
  };
}

export function userFacingBlock(opts: {
  stopReason?: string | null;
  runtimeMessage?: string | null;
  snapshotReason?: string | null;
  zeroEngines?: boolean;
}): { stateDetail: string; stateCode: EngineStateCode | string } {
  if (opts.zeroEngines) {
    return {
      stateCode: "no_engines",
      stateDetail:
        "No local engines are available. Install and sign in to Claude, Codex, Grok, or Gemini, then pick a model in Settings.",
    };
  }
  if (isSpawnFailure(opts.stopReason, opts.runtimeMessage)) {
    const reason =
      (opts.snapshotReason && opts.snapshotReason.trim()) ||
      humanizeSpawnMessage(opts.runtimeMessage) ||
      "The selected engine CLI is not available. Install it or switch models in Settings.";
    return { stateCode: "spawn_error", stateDetail: reason };
  }
  if (opts.stopReason === "auth_required") {
    return {
      stateCode: "auth_required",
      stateDetail:
        (opts.snapshotReason && opts.snapshotReason.trim()) ||
        (opts.runtimeMessage && opts.runtimeMessage.trim()) ||
        "This engine is not signed in. Finish login in its CLI, then retry.",
    };
  }
  if (opts.stopReason && isMachineStateCode(opts.stopReason)) {
    const detail =
      (opts.snapshotReason && opts.snapshotReason.trim()) ||
      (opts.runtimeMessage && opts.runtimeMessage.trim()) ||
      "The selected engine is not available. Install it or switch models in Settings.";
    return { stateCode: opts.stopReason, stateDetail: detail };
  }
  const detail =
    (opts.runtimeMessage && opts.runtimeMessage.trim()) ||
    (opts.snapshotReason && opts.snapshotReason.trim()) ||
    (opts.stopReason && opts.stopReason.trim()) ||
    "The selected engine is not available.";
  return {
    stateCode: "engine_unavailable",
    stateDetail: detail.slice(0, 160),
  };
}

function humanizeSpawnMessage(message?: string | null): string | undefined {
  if (!message) return undefined;
  // "spawn failed: spawn ENOENT …" — drop the machine prefix, keep the rest
  const stripped = message.replace(/^spawn failed:\s*/i, "").trim();
  if (!stripped || stripped === "spawn_error") return undefined;
  if (/^spawn_error$/i.test(stripped)) return undefined;
  return stripped.slice(0, 160);
}
