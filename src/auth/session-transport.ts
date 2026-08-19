export const SESSION_PROBE_PATH = "/api/session";
export const GITHUB_SIGN_IN_START_PATH = "/api/auth/github/start";
export const AUTHORIZATION_RESULT_PATH = "/auth/result";
export const SIGN_OUT_PATH = "/api/auth/sign-out";

const MAX_AUTH_RESPONSE_BYTES = 4_096;
const DEFAULT_TIMEOUT_MS = 5_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INVALID_JSON = Symbol("invalid-json");

export type SessionProbeOutcome = "authenticated" | "unauthenticated" | "unavailable";
export type SignOutOutcome = "confirmed" | "unconfirmed";
export type AuthorizationStartOutcome = "started" | "unavailable";
export type AuthorizationResultOutcome =
  | "none"
  | "authenticated"
  | "sign_in_declined"
  | "callback_rejected"
  | "service_unavailable";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface TransportOptions {
  fetch?: FetchLike;
  timeoutMs?: number;
}

export interface AuthorizationLocation {
  pathname: string;
  search: string;
  hash: string;
  assign(path: string): void;
  replace(path: string): void;
}

export interface AuthorizationHistory {
  replaceState(data: unknown, unused: string, url?: string | URL | null): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index]);
}

function hasJsonContentType(response: Response): boolean {
  return response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

async function boundedJson(response: Response): Promise<unknown | typeof INVALID_JSON> {
  if (!hasJsonContentType(response)) return INVALID_JSON;
  const declaredLength = response.headers.get("content-length");
  if (declaredLength && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_AUTH_RESPONSE_BYTES)) {
    return INVALID_JSON;
  }
  try {
    const text = await response.text();
    if (text.length === 0 || text.length > MAX_AUTH_RESPONSE_BYTES) return INVALID_JSON;
    return JSON.parse(text) as unknown;
  } catch {
    return INVALID_JSON;
  }
}

async function fetchWithTimeout(
  path: string,
  init: RequestInit,
  options: TransportOptions,
): Promise<Response | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    return await (options.fetch ?? fetch)(path, { ...init, signal: controller.signal });
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function normalizeSessionResponse(response: Response): Promise<SessionProbeOutcome> {
  if (response.status !== 200 && response.status !== 401) return "unavailable";
  const body = await boundedJson(response);
  if (!isRecord(body)) return "unavailable";

  if (response.status === 401) {
    return hasExactKeys(body, ["error"]) && body.error === "unauthorized"
      ? "unauthenticated"
      : "unavailable";
  }

  if (!hasExactKeys(body, ["user"]) || !isRecord(body.user) || !hasExactKeys(body.user, ["id"])) {
    return "unavailable";
  }
  return typeof body.user.id === "string" && UUID.test(body.user.id)
    ? "authenticated"
    : "unavailable";
}

export async function probeSession(options: TransportOptions = {}): Promise<SessionProbeOutcome> {
  const response = await fetchWithTimeout(
    SESSION_PROBE_PATH,
    {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      headers: { accept: "application/json" },
    },
    options,
  );
  return response ? normalizeSessionResponse(response) : "unavailable";
}

export async function probeSessionWithBoundedRetry(
  options: TransportOptions = {},
  wait: (milliseconds: number) => Promise<void> = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
): Promise<SessionProbeOutcome> {
  const first = await probeSession(options);
  if (first !== "unavailable") return first;
  await wait(250);
  return probeSession(options);
}

export function beginGithubAuthorization(
  navigate: (path: string) => void = (path) => window.location.assign(path),
): AuthorizationStartOutcome {
  try {
    // The caller supplies no URL or return target. Every invocation reaches
    // the reviewed server start route and therefore mints a new transaction.
    navigate(GITHUB_SIGN_IN_START_PATH);
    return "started";
  } catch {
    return "unavailable";
  }
}

export function readAuthorizationResult(location: Pick<AuthorizationLocation, "pathname" | "search" | "hash">): AuthorizationResultOutcome {
  if (location.pathname !== AUTHORIZATION_RESULT_PATH) return "none";
  const params = new URLSearchParams(location.search);
  const values = params.getAll("outcome");
  const onlyOutcome = [...params.keys()].every((key) => key === "outcome");
  if (!onlyOutcome || values.length !== 1 || location.hash !== "") return "callback_rejected";
  const outcome = values[0];
  if (
    outcome === "authenticated" ||
    outcome === "sign_in_declined" ||
    outcome === "callback_rejected" ||
    outcome === "service_unavailable"
  ) {
    return outcome;
  }
  return "callback_rejected";
}

export interface ConsumedAuthorizationResult {
  outcome: AuthorizationResultOutcome;
  scrubbed: boolean;
}

export function consumeAuthorizationResult(
  location: AuthorizationLocation,
  history: AuthorizationHistory,
): ConsumedAuthorizationResult {
  const outcome = readAuthorizationResult(location);
  if (outcome === "none") return { outcome, scrubbed: true };
  try {
    history.replaceState(null, "", "/");
    return { outcome, scrubbed: true };
  } catch {
    try {
      location.replace("/");
    } catch {
      // Remain on the closed checking view. No returned outcome is rendered.
    }
    return { outcome: "none", scrubbed: false };
  }
}

export async function signOut(options: TransportOptions = {}): Promise<SignOutOutcome> {
  const response = await fetchWithTimeout(
    SIGN_OUT_PATH,
    {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      headers: { accept: "application/json" },
    },
    options,
  );
  return response?.status === 204 ? "confirmed" : "unconfirmed";
}

export interface SessionTransport {
  probe(): Promise<SessionProbeOutcome>;
  beginSignIn(): AuthorizationStartOutcome;
  signOut(): Promise<SignOutOutcome>;
}

export function createSessionTransport(options: TransportOptions = {}): SessionTransport {
  return {
    probe: () => probeSessionWithBoundedRetry(options),
    beginSignIn: () => beginGithubAuthorization(),
    signOut: () => signOut(options),
  };
}
