// Local usage totals for routed inference (P7). Incremented when a
// provider turn completes. These are activity records for Settings —
// not a provider invoice and never a place for secrets.
import type { UsageRepository, ProviderUsageRow } from "../repositories/usage.ts";

export interface PublicProviderUsage {
  provider: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
}

export interface UsageService {
  record(provider: string, delta: { requests?: number; inputTokens?: number; outputTokens?: number }): PublicProviderUsage | null;
  totals(): PublicProviderUsage[];
}

const PUBLIC_USAGE_KEYS = ["provider", "requests", "inputTokens", "outputTokens"] as const;

function toPublic(row: ProviderUsageRow): PublicProviderUsage {
  return {
    provider: row.provider,
    requests: row.requests,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
  };
}

export function createUsageService(deps: {
  store: UsageRepository;
  now?: () => number;
}): UsageService {
  const now = deps.now ?? (() => Date.now());
  return {
    record(provider, delta) {
      const name = String(provider ?? "").trim();
      if (!name) return null;
      try {
        return toPublic(deps.store.record(name, delta, now()));
      } catch {
        return null;
      }
    },
    totals() {
      return deps.store.list().map(toPublic);
    },
  };
}

export function publicUsageFieldNames(): readonly string[] {
  return PUBLIC_USAGE_KEYS;
}
