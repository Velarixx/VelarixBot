// Spend cap for the Playwright eval. Repo var TIER_B_MAX_TURNS (default 40).
// A missing/invalid value falls back to 40 — never unbounded.

const DEFAULT_MAX_TURNS = 40;

export function maxTurns(env = process.env) {
  const raw = env.TIER_B_MAX_TURNS;
  if (raw === undefined || raw === null || String(raw).trim() === "") return DEFAULT_MAX_TURNS;
  const n = Number.parseInt(String(raw), 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_TURNS;
}
