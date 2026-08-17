// ACP model-catalog parsers. Gemini advertises the live list on
// session/new (`models.availableModels`). Grok/Hermes may eventually
// advertise a list on initialize `_meta.modelState`. A lone
// `currentModelId` is not a catalog — keep the driver's static fallback.
import type { ModelCatalog } from "../../contracts.ts";

function optionFrom(raw: unknown): { id: string; label: string } | null {
  if (typeof raw === "string") {
    const id = raw.trim();
    return id ? { id, label: id } : null;
  }
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const id = typeof row.modelId === "string" ? row.modelId : typeof row.id === "string" ? row.id : "";
  const trimmed = id.trim();
  if (!trimmed) return null;
  const name = typeof row.name === "string" ? row.name : typeof row.displayName === "string" ? row.displayName : "";
  return { id: trimmed, label: name.trim() || trimmed };
}

/** session/new (and session/load) `models.availableModels` → picker catalog. */
export function catalogFromAvailableModels(raw: unknown): ModelCatalog | null {
  const models = (raw as { models?: { availableModels?: unknown; currentModelId?: unknown } } | null)?.models;
  const list = models?.availableModels;
  if (!Array.isArray(list) || !list.length) return null;
  const seen = new Set<string>();
  const options: ModelCatalog["options"] = [];
  for (const row of list) {
    const opt = optionFrom(row);
    if (!opt || seen.has(opt.id)) continue;
    seen.add(opt.id);
    options.push(opt);
  }
  if (!options.length) return null;
  const current = typeof models?.currentModelId === "string" ? models.currentModelId.trim() : "";
  return { default: current && seen.has(current) ? current : options[0]!.id, options };
}

/** initialize `_meta.modelState` — only when it carries a list, not just currentModelId. */
export function catalogFromModelState(init: unknown): ModelCatalog | null {
  const state = (init as { _meta?: { modelState?: unknown } } | null)?._meta?.modelState;
  if (!state || typeof state !== "object") return null;
  const row = state as Record<string, unknown>;
  const list = row.availableModels ?? row.models;
  if (!Array.isArray(list) || !list.length) return null;
  return catalogFromAvailableModels({
    models: { availableModels: list, currentModelId: row.currentModelId },
  });
}
