export const DESKTOP_ACCESS_PATH = "/api/desktop-access";
export const DESKTOP_VIEW_PATH = `${DESKTOP_ACCESS_PATH}/view`;
export const DESKTOP_ACCESS_TIMEOUT_MS = 5_000;

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type DesktopAccessOutcome =
  | { kind: "active"; expiresAt: number }
  | { kind: "absent" }
  | { kind: "denied" }
  | { kind: "unauthenticated" }
  | { kind: "unavailable" };

export type DesktopRevokeOutcome = "revoked" | "unauthenticated" | "unavailable";

export interface DesktopAccessTransport {
  check(signal?: AbortSignal): Promise<DesktopAccessOutcome>;
  request(signal?: AbortSignal): Promise<DesktopAccessOutcome>;
  revoke(signal?: AbortSignal): Promise<DesktopRevokeOutcome>;
}

function exactAccess(body: unknown): number | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  if (Object.keys(body).length !== 1 || !("access" in body)) return null;
  const access = (body as { access?: unknown }).access;
  if (!access || typeof access !== "object" || Array.isArray(access)) return null;
  if (Object.keys(access).length !== 1 || !("expiresAt" in access)) return null;
  const expiresAt = (access as { expiresAt?: unknown }).expiresAt;
  return Number.isSafeInteger(expiresAt) && (expiresAt as number) > 0 ? expiresAt as number : null;
}

async function parsedAccess(response: Response): Promise<DesktopAccessOutcome> {
  if (response.status === 401) return { kind: "unauthenticated" };
  if (response.status === 403) return { kind: "denied" };
  if (response.status === 410) return { kind: "absent" };
  if (response.status !== 200 && response.status !== 201) return { kind: "unavailable" };
  if (!(response.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    return { kind: "unavailable" };
  }
  try {
    const expiresAt = exactAccess(await response.json());
    return expiresAt === null ? { kind: "unavailable" } : { kind: "active", expiresAt };
  } catch {
    return { kind: "unavailable" };
  }
}

async function boundedFetch(
  fetcher: FetchLike,
  timeoutMs: number,
  input: RequestInfo | URL,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    return await fetcher(input, { ...init, signal: controller.signal });
  } finally {
    globalThis.clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

export function createDesktopAccessTransport(options: {
  fetch?: FetchLike;
  timeoutMs?: number;
} = {}): DesktopAccessTransport {
  const fetcher = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DESKTOP_ACCESS_TIMEOUT_MS;

  return {
    async check(signal) {
      try {
        return await parsedAccess(await boundedFetch(fetcher, timeoutMs, DESKTOP_ACCESS_PATH, {
          method: "GET",
          credentials: "same-origin",
          cache: "no-store",
          headers: { accept: "application/json" },
        }, signal));
      } catch {
        return { kind: "unavailable" };
      }
    },
    async request(signal) {
      try {
        return await parsedAccess(await boundedFetch(fetcher, timeoutMs, DESKTOP_ACCESS_PATH, {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
          headers: { accept: "application/json", "content-type": "application/json" },
          body: "{}",
        }, signal));
      } catch {
        return { kind: "unavailable" };
      }
    },
    async revoke(signal) {
      try {
        const response = await boundedFetch(fetcher, timeoutMs, DESKTOP_ACCESS_PATH, {
          method: "DELETE",
          credentials: "same-origin",
          cache: "no-store",
          headers: { accept: "application/json" },
        }, signal);
        if (response.status === 204) return "revoked";
        if (response.status === 401) return "unauthenticated";
        return "unavailable";
      } catch {
        return "unavailable";
      }
    },
  };
}
