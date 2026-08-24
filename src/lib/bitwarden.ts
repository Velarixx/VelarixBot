/** Per-bot Bitwarden allowlist. Empty/missing = none. */

export function bitwardenIds(list: string[] | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const id = String(raw).trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export function toggleBitwardenId(current: string[] | undefined, id: string): string[] {
  const next = bitwardenIds(current);
  const key = id.trim();
  if (!key) return next;
  return next.includes(key) ? next.filter((item) => item !== key) : [...next, key];
}

export type BitwardenStatus = "connected" | "disconnected" | "error";

export interface BitwardenHubStatus {
  configured: boolean;
  status: BitwardenStatus;
  nextStep: string;
  error?: string;
  projects: Array<{ id: string; name: string }>;
  secrets: Array<{ id: string; key: string; projectId?: string }>;
}

export const BITWARDEN_PATHS = {
  status: "/api/bitwarden",
  disconnect: "/api/bitwarden/disconnect",
} as const;
