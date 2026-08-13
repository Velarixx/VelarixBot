// Peer-agent comms helpers: depth cap, visited-set cycle guard, and the
// group-thread participant set. The harness owns turns; these are the
// pure bits tests can pin without booting the HTTP server.
export const MAX_COMMS_DEPTH = 2;
export const COMMS_DEPTH_ERROR = "message chains are limited to two hops";
export const COMMS_CYCLE_ERROR = "cycle: that bot is already in this message chain";
export const ASK_BUDGET_MS = 4 * 60_000;

export function parseVisited(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return [...new Set(raw.map((id) => String(id).trim()).filter(Boolean))];
  }
  if (typeof raw === "string") {
    return [...new Set(raw.split(",").map((id) => id.trim()).filter(Boolean))];
  }
  return [];
}

/** Chain so far, including the caller. Rejects self-asks and revisits. */
export function commsGuard(
  fromBotId: string,
  toBotId: string,
  depth: number,
  visited: string[],
): { ok: true; chain: string[] } | { ok: false; error: string } {
  if (!toBotId) return { ok: false, error: "toBotId and message required" };
  if (toBotId === fromBotId) return { ok: false, error: "a bot cannot message itself" };
  if (depth >= MAX_COMMS_DEPTH) return { ok: false, error: COMMS_DEPTH_ERROR };
  const chain = parseVisited([...visited, fromBotId]);
  if (chain.includes(toBotId)) return { ok: false, error: COMMS_CYCLE_ERROR };
  return { ok: true, chain };
}

export function uniqueIds(ids: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    const v = String(id).trim();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}
