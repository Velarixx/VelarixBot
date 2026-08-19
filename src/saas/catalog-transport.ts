import { MAUS_COLOR_NAMES, type MausColor } from "@/lib/mascot";

export const CATALOG_PATH = "/api/bots?messages=0";
export const MAX_CATALOG_RESPONSE_BYTES = 128 * 1024;
export const MAX_CATALOG_ITEMS = 500;

const DEFAULT_TIMEOUT_MS = 5_000;
const INVALID_BODY = Symbol("invalid-body");
const ITEM_KEYS = ["color", "description", "hasMore", "messages", "name", "title"];
const ENVELOPE_KEYS = ["bots"];
const COLOR_NAMES = new Set<string>(MAUS_COLOR_NAMES);

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface CatalogItem {
  name: string;
  title: string;
  description: string;
  color: MausColor;
}

export type CatalogLoadOutcome =
  | { kind: "success"; items: CatalogItem[] }
  | { kind: "unauthenticated" }
  | { kind: "unavailable" };

export interface CatalogTransportOptions {
  fetch?: FetchLike;
  timeoutMs?: number;
  signal?: AbortSignal;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const keys = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return keys.length === sortedExpected.length && keys.every((key, index) => key === sortedExpected[index]);
}

function isCatalogText(value: unknown): value is string {
  return typeof value === "string" && value.length <= 4_096;
}

function validateEnvelope(value: unknown): CatalogItem[] | null {
  if (!isRecord(value) || !hasExactKeys(value, ENVELOPE_KEYS) || !Array.isArray(value.bots)) return null;
  if (value.bots.length > MAX_CATALOG_ITEMS) return null;

  const items: CatalogItem[] = [];
  for (const candidate of value.bots) {
    if (!isRecord(candidate) || !hasExactKeys(candidate, ITEM_KEYS)) return null;
    if (
      !isCatalogText(candidate.name) ||
      !isCatalogText(candidate.title) ||
      !isCatalogText(candidate.description) ||
      typeof candidate.color !== "string" ||
      !COLOR_NAMES.has(candidate.color) ||
      !Array.isArray(candidate.messages) ||
      candidate.messages.length !== 0 ||
      typeof candidate.hasMore !== "boolean"
    ) {
      return null;
    }
    // Project once more on the client. Even reviewed-but-unused server fields
    // do not enter component state.
    items.push({
      name: candidate.name,
      title: candidate.title,
      description: candidate.description,
      color: candidate.color as MausColor,
    });
  }
  return items;
}

async function boundedJson(response: Response): Promise<unknown | typeof INVALID_BODY> {
  if (response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    return INVALID_BODY;
  }
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength &&
    (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_CATALOG_RESPONSE_BYTES)
  ) {
    return INVALID_BODY;
  }
  if (!response.body) return INVALID_BODY;

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_CATALOG_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        return INVALID_BODY;
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    if (bytes === 0) return INVALID_BODY;
    return JSON.parse(text) as unknown;
  } catch {
    return INVALID_BODY;
  }
}

export async function loadCatalog(options: CatalogTransportOptions = {}): Promise<CatalogLoadOutcome> {
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort();
  options.signal?.addEventListener("abort", abortFromCaller, { once: true });
  if (options.signal?.aborted) controller.abort();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  try {
    const response = await (options.fetch ?? fetch)(CATALOG_PATH, {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });

    // Any 401 means the browser-managed session is no longer authoritative.
    // Do not parse or retain its body.
    if (response.status === 401) return { kind: "unauthenticated" };
    if (response.status !== 200) return { kind: "unavailable" };
    const body = await boundedJson(response);
    if (body === INVALID_BODY) return { kind: "unavailable" };
    const items = validateEnvelope(body);
    return items ? { kind: "success", items } : { kind: "unavailable" };
  } catch {
    return { kind: "unavailable" };
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abortFromCaller);
  }
}

export interface CatalogTransport {
  load(signal: AbortSignal): Promise<CatalogLoadOutcome>;
}

export function createCatalogTransport(
  options: Omit<CatalogTransportOptions, "signal"> = {},
): CatalogTransport {
  return { load: (signal) => loadCatalog({ ...options, signal }) };
}
