// A1 Avatar Tier A: seeded procedural mascot, zero keys. One pure function
// maps a stable identity (bot id, or name for callers that have no id yet)
// plus a small persisted nonce to a face — no network, no image provider,
// no randomness. Re-rolling is "bump the nonce and re-derive"; the same
// identity + nonce always regenerates the same color/shape/expression.
import { COLORS, ICON_SHAPES, type IconShape, type MausColor } from "./store.ts";

/** Resting faces a seed may pin — mirrors PICKABLE_STATES in
 * src/lib/mascot.ts (one state per distinct resting face). */
export const SEED_EXPRESSIONS = [
  "idle",
  "happy",
  "curious",
  "drowsy",
  "working",
  "thinking",
  "listening",
  "sleeping",
  "suspicious",
  "proud",
] as const;
export type SeedExpression = (typeof SEED_EXPRESSIONS)[number];

export interface AvatarSeed {
  /** Preferred key: survives renames. */
  botId?: string;
  /** Fallback key when no id exists yet. */
  name?: string;
  /** Persisted re-roll counter (avatarNonce on the bot record). */
  nonce: number;
}

export interface SeededAvatar {
  color: MausColor;
  iconShape: IconShape;
  mascotExpression: SeedExpression;
}

/** FNV-1a 32-bit — tiny, dependency-free, and identical on every platform. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Deterministically derive a mascot face from an identity + nonce. Pure:
 * the same seed always returns the same face; changing the nonce re-rolls
 * every facet independently (each facet hashes with its own salt so a
 * nonce bump never shifts all three lists in lockstep). */
export function seedAvatar(seed: AvatarSeed): SeededAvatar {
  const key = seed.botId ?? seed.name ?? "";
  const nonce = Number.isInteger(seed.nonce) && seed.nonce >= 0 ? seed.nonce : 0;
  const pick = <T,>(list: readonly T[], facet: string): T =>
    list[fnv1a(`${facet}\u0000${key}\u0000${nonce}`) % list.length];
  return {
    color: pick(COLORS, "color"),
    iconShape: pick(ICON_SHAPES, "shape"),
    mascotExpression: pick(SEED_EXPRESSIONS, "expression"),
  };
}

/** Route/service guard for the PATCHable avatarNonce field. */
export function validAvatarNonce(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}
