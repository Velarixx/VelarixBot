// Codex model catalog — the picker used to ship a 3-entry hardcoded list
// (Sol / Terra / 5.4) ported from an older contracts snapshot. The
// installed `codex` CLI exposes a larger catalog via `codex debug models`
// (JSON `{ models: [{ slug, display_name, visibility }] }`, same shape as
// the bundled models.json / models_cache.json). App-server `model/list`
// is the same catalog over JSON-RPC; we ask the CLI so snapshot/create
// don't need a long-lived app-server.
//
// Live dump first (`debug models --bundled` is the binary's catalog, no
// network and no cache write). If that flag is unknown or the CLI errors,
// retry without `--bundled`. Parse failure → FALLBACK_CODEX_MODELS, which
// is the bundled CLI list (Luna included; Sol/Terra/5.4 kept).
import type { ModelCatalog } from "../contracts.ts";
import { augmentedPath } from "../env-path.ts";
import { cliExec } from "./cli.ts";

const DEFAULT_MODEL = "gpt-5.6-sol";

/** Human labels for slugs the CLI/docs actually list. Unknown slugs keep
 * the CLI's display_name (hyphenated Sol/Terra/Luna/Mini → spaces). */
const LABELS: Record<string, string> = {
  "gpt-5.6-sol": "GPT-5.6 Sol",
  "gpt-5.6-terra": "GPT-5.6 Terra",
  "gpt-5.6-luna": "GPT-5.6 Luna",
  "gpt-5.6": "GPT-5.6",
  "gpt-5.5": "GPT-5.5",
  "gpt-5.4": "GPT-5.4",
  "gpt-5.4-mini": "GPT-5.4 Mini",
  "gpt-5.2": "GPT-5.2",
};

/** Fallback when the local CLI cannot dump a catalog. Slugs come from the
 * Codex CLI bundled catalog (`codex debug models --bundled` / models.json)
 * and official Codex model docs — not invented. Hidden gpt-* entries stay
 * so the previous picker (Sol/Terra/5.4) is not a subset we drop. */
export const FALLBACK_CODEX_MODELS: ModelCatalog = {
  default: DEFAULT_MODEL,
  options: [
    { id: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
    { id: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
    { id: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
    { id: "gpt-5.5", label: "GPT-5.5" },
    { id: "gpt-5.4", label: "GPT-5.4" },
    { id: "gpt-5.4-mini", label: "GPT-5.4 Mini" },
    { id: "gpt-5.2", label: "GPT-5.2" },
  ],
};

export function labelForCodexModel(id: string, displayName?: string): string {
  if (LABELS[id]) return LABELS[id];
  if (displayName?.trim()) {
    return displayName.trim().replace(/-(Sol|Terra|Luna|Mini)$/i, " $1");
  }
  return id;
}

function modelId(raw: Record<string, unknown>): string | null {
  const slug = raw.slug ?? raw.id;
  if (typeof slug !== "string") return null;
  const id = slug.trim();
  return id || null;
}

function visibilityOf(raw: Record<string, unknown>): string | null {
  return typeof raw.visibility === "string" ? raw.visibility.toLowerCase() : null;
}

/** Skip internal/non-chat rows. `list` (and missing visibility) always
 * qualify; `hide` only for gpt-* so legacy 5.4 stays without Auto Review. */
function includeModel(id: string, raw: Record<string, unknown>): boolean {
  if (id === "codex-auto-review") return false;
  const visibility = visibilityOf(raw);
  if (visibility === "none") return false;
  if (visibility === "hide") return id.startsWith("gpt-");
  return true;
}

function asObjectList(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) {
    return value.filter((row): row is Record<string, unknown> => !!row && typeof row === "object");
  }
  if (value && typeof value === "object") {
    const models = (value as { models?: unknown }).models;
    if (Array.isArray(models)) {
      return models.filter((row): row is Record<string, unknown> => !!row && typeof row === "object");
    }
  }
  return [];
}

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const obj = trimmed.indexOf("{");
    const arr = trimmed.indexOf("[");
    const start = obj === -1 ? arr : arr === -1 ? obj : Math.min(obj, arr);
    if (start === -1) return null;
    try {
      return JSON.parse(trimmed.slice(start));
    } catch {
      return null;
    }
  }
}

/** Parse `codex debug models` stdout. Null when nothing usable is present
 * so the caller can fall back to the static catalog. */
export function parseCodexModelCatalog(stdout: string): ModelCatalog | null {
  const rows = asObjectList(extractJson(stdout));
  const seen = new Set<string>();
  const options: ModelCatalog["options"] = [];
  for (const row of rows) {
    const id = modelId(row);
    if (!id || seen.has(id) || !includeModel(id, row)) continue;
    seen.add(id);
    const displayName = typeof row.display_name === "string" ? row.display_name : undefined;
    options.push({ id, label: labelForCodexModel(id, displayName) });
  }
  if (!options.length) return null;
  const defaultId = seen.has(DEFAULT_MODEL) ? DEFAULT_MODEL : options[0]!.id;
  return { default: defaultId, options };
}

export async function loadCodexModelCatalog(
  cli: string,
  env: NodeJS.ProcessEnv = { ...process.env, PATH: augmentedPath() },
): Promise<ModelCatalog> {
  try {
    const run = (args: string[]) => cliExec(cli, args, { timeout: 8000, env });
    let result = await run(["debug", "models", "--bundled"]);
    if (!result.ok || !result.stdout.trim()) {
      result = await run(["debug", "models"]);
    }
    return parseCodexModelCatalog(result.ok ? result.stdout : "") ?? FALLBACK_CODEX_MODELS;
  } catch {
    return FALLBACK_CODEX_MODELS;
  }
}
