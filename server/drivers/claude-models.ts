// Claude Code model catalog. The picker used to ship a 4-id hardcoded
// list. `claude models` is the CLI's own dump (Claude Code, not
// `ant models list`). Parse failure → FALLBACK_CLAUDE_MODELS.
//
// [VERIFY] 2026-08-17: no live `claude models` stdout was available in
// this environment. The probe still runs; the fake CLI speaks JSON
// `{ models: [{ id, display_name }] }` (and one-id-per-line as a
// fallback) so tests can prove the path. A live dump that differs will
// fail parse and keep the dated 4-id list — never invent ids.
import type { ModelCatalog } from "../contracts.ts";
import { augmentedPath } from "../env-path.ts";
import { cliExec } from "./cli.ts";

export const FALLBACK_CLAUDE_MODELS: ModelCatalog = {
  default: "claude-sonnet-5",
  options: [
    { id: "claude-fable-5", label: "Claude Fable 5" },
    { id: "claude-opus-5", label: "Claude Opus 5" },
    { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
    { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
  ],
};

function labelFor(id: string, displayName?: string): string {
  if (displayName?.trim()) return displayName.trim();
  return id;
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

function asRows(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    const models = (value as { models?: unknown }).models;
    if (Array.isArray(models)) return models;
  }
  return [];
}

/** Parse `claude models` stdout. Null when nothing usable is present. */
export function parseClaudeModelCatalog(stdout: string): ModelCatalog | null {
  const json = extractJson(stdout);
  const rows = json !== null ? asRows(json) : stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[A-Za-z0-9][\w.+/-]*$/.test(line));
  const seen = new Set<string>();
  const options: ModelCatalog["options"] = [];
  for (const row of rows) {
    if (typeof row === "string") {
      const id = row.trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      options.push({ id, label: id });
      continue;
    }
    if (!row || typeof row !== "object") continue;
    const rec = row as Record<string, unknown>;
    const id = typeof rec.id === "string" ? rec.id.trim() : typeof rec.slug === "string" ? rec.slug.trim() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const displayName = typeof rec.display_name === "string" ? rec.display_name : typeof rec.name === "string" ? rec.name : undefined;
    options.push({ id, label: labelFor(id, displayName) });
  }
  if (!options.length) return null;
  const defaultId = seen.has(FALLBACK_CLAUDE_MODELS.default) ? FALLBACK_CLAUDE_MODELS.default : options[0]!.id;
  return { default: defaultId, options };
}

export async function loadClaudeModelCatalog(
  cli: string,
  env: NodeJS.ProcessEnv = { ...process.env, PATH: augmentedPath() },
): Promise<ModelCatalog> {
  try {
    const result = await cliExec(cli, ["models"], { timeout: 8000, env });
    return parseClaudeModelCatalog(result.ok ? result.stdout : "") ?? FALLBACK_CLAUDE_MODELS;
  } catch {
    return FALLBACK_CLAUDE_MODELS;
  }
}
