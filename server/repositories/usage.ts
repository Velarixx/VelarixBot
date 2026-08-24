// Local per-provider usage totals for routed inference (P7).
// Request counts and token in/out only — not billed amounts, not secrets.
import type { SqliteDatabase } from "../db/sqlite-native.ts";

export interface ProviderUsageRow {
  provider: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  updatedAt: number;
}

export interface UsageDelta {
  requests?: number;
  inputTokens?: number;
  outputTokens?: number;
}

export interface UsageRepository {
  record(provider: string, delta: UsageDelta, updatedAt: number): ProviderUsageRow;
  list(): ProviderUsageRow[];
  get(provider: string): ProviderUsageRow | null;
}

function toRow(row: {
  provider: string;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  updated_at: number;
}): ProviderUsageRow {
  return {
    provider: row.provider,
    requests: row.requests,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    updatedAt: row.updated_at,
  };
}

function nonNegInt(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

export function createUsageRepository(db: SqliteDatabase): UsageRepository {
  const select = db.prepare<{
    provider: string;
    requests: number;
    input_tokens: number;
    output_tokens: number;
    updated_at: number;
  }>("SELECT provider, requests, input_tokens, output_tokens, updated_at FROM provider_usage WHERE provider = ?");
  const selectAll = db.prepare<{
    provider: string;
    requests: number;
    input_tokens: number;
    output_tokens: number;
    updated_at: number;
  }>("SELECT provider, requests, input_tokens, output_tokens, updated_at FROM provider_usage ORDER BY provider");
  const upsert = db.prepare(
    `INSERT INTO provider_usage(provider, requests, input_tokens, output_tokens, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(provider) DO UPDATE SET
       requests = requests + excluded.requests,
       input_tokens = input_tokens + excluded.input_tokens,
       output_tokens = output_tokens + excluded.output_tokens,
       updated_at = excluded.updated_at`,
  );

  return {
    record(provider, delta, updatedAt) {
      const name = String(provider ?? "").trim();
      if (!name || name.length > 128) throw new Error("provider required");
      upsert.run(
        name,
        nonNegInt(delta.requests),
        nonNegInt(delta.inputTokens),
        nonNegInt(delta.outputTokens),
        updatedAt,
      );
      return toRow(select.get(name)!);
    },
    list() {
      return selectAll.all().map(toRow);
    },
    get(provider) {
      const raw = select.get(String(provider ?? "").trim());
      return raw ? toRow(raw) : null;
    },
  };
}
