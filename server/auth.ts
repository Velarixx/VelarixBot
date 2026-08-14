// Per-launch capability for the local HTTP API. The server is loopback-only,
// but "any local caller" is still too broad: before this gate, every
// state-changing route (approvals /respond, bot create/delete, config,
// routine run) accepted any process or browser page that could reach
// 127.0.0.1. Now every /api/* request except /api/health must present the
// launch token; Electron main generates it, hands it to the forked server
// via env, and injects it as an Authorization header on all renderer
// requests (including the EventSource SSE stream, which cannot set headers
// itself). Dev runs set VELARIX_DEV_TOKEN explicitly — there is no
// silent-off: without a token in env the server mints a random one nobody
// holds, which fails closed. Host must be the loopback bind (DNS-rebinding
// guard) and browser Origins are rejected on state changes. The
// /api/internal COMMS token is a separate credential and stays that way.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** 256-bit hex token: env-injected (Electron main / VELARIX_DEV_TOKEN for
 * dev) or freshly minted. A minted token is never shared, so with no env
 * token the API is effectively locked — fail closed, never silent-off. */
export function resolveApiToken(env: Record<string, string | undefined> = process.env): string {
  const injected = (env.VELARIX_API_TOKEN ?? "").trim() || (env.VELARIX_DEV_TOKEN ?? "").trim();
  return injected || randomBytes(32).toString("hex");
}

/** Constant-time bearer check (hash first so lengths never differ). */
export function tokenMatches(authorization: string | undefined, token: string): boolean {
  const presented = /^Bearer\s+(.+)$/i.exec(authorization ?? "")?.[1]?.trim();
  if (!presented || !token) return false;
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(token).digest();
  return timingSafeEqual(a, b);
}

/** /api/health stays open: the packaged app's port-fallback probe and the
 * release smoke identify the server by pid+stamp before any token exists
 * client-side. It leaks nothing beyond pid/stamp. */
export function isAuthExempt(path: string): boolean {
  return path === "/api/health";
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** DNS-rebinding guard: the Host header must name the loopback bind (any
 * loopback literal, port matching the bound port when present). */
export function hostAllowed(host: string | undefined, port: number): boolean {
  if (!host) return false;
  const match = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(host.trim().toLowerCase());
  if (!match) return false;
  if (!LOOPBACK_HOSTS.has(match[1])) return false;
  return match[2] === undefined || Number(match[2]) === port;
}

/** Browser pages must not drive state changes. No Origin (same-origin
 * fetches, node clients) is fine; loopback origins (the packaged window,
 * the vite dev origin) are fine; anything else is rejected. */
export function originAllowed(origin: string | undefined): boolean {
  if (origin === undefined || origin === "") return true;
  if (origin === "null") return false; // opaque origin (sandboxed/file page)
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return LOOPBACK_HOSTS.has(url.hostname === "::1" ? "[::1]" : url.hostname);
}

const STATE_CHANGING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export type AuthFailure = { status: number; error: string };

/** One gate for every /api/* route (except /api/health and the separately
 * tokened /api/internal/*). Returns null when the request may proceed. */
export function requireApiAuth(
  input: {
    path: string;
    method: string;
    headers: { authorization?: string; host?: string; origin?: string };
  },
  token: string,
  port: number,
): AuthFailure | null {
  if (isAuthExempt(input.path)) return null;
  if (!hostAllowed(input.headers.host, port)) return { status: 403, error: "forbidden host" };
  if (STATE_CHANGING.has(input.method.toUpperCase()) && !originAllowed(input.headers.origin)) {
    return { status: 403, error: "forbidden origin" };
  }
  if (!tokenMatches(input.headers.authorization, token)) return { status: 401, error: "unauthorized" };
  return null;
}
