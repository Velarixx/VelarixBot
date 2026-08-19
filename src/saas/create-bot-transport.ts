export const CREATE_BOT_PATH = "/api/bots";
export const MAX_CREATE_RESPONSE_BYTES = 128 * 1024;

const DEFAULT_TIMEOUT_MS = 5_000;

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type CreateBotOutcome =
  | { kind: "success" }
  | { kind: "unauthenticated" }
  | { kind: "quota_reached" }
  | { kind: "unavailable" };

export interface CreateBotTransportOptions {
  fetch?: FetchLike;
  timeoutMs?: number;
  signal?: AbortSignal;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function hasBoundedCreateEnvelope(response: Response): Promise<boolean> {
  if (response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    return false;
  }
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength &&
    (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_CREATE_RESPONSE_BYTES)
  ) {
    return false;
  }
  if (!response.body) return false;

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_CREATE_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        return false;
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    if (bytes === 0) return false;
    const envelope: unknown = JSON.parse(text);
    return isRecord(envelope) && Object.keys(envelope).length === 1 && isRecord(envelope.bot);
  } catch {
    return false;
  }
}

export async function createBot(options: CreateBotTransportOptions = {}): Promise<CreateBotOutcome> {
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort();
  options.signal?.addEventListener("abort", abortFromCaller, { once: true });
  if (options.signal?.aborted) controller.abort();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  try {
    const response = await (options.fetch ?? fetch)(CREATE_BOT_PATH, {
      method: "POST",
      body: "{}",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      signal: controller.signal,
    });

    // These outcomes deliberately ignore response bodies so server or proxy
    // detail cannot cross into UI state or announcements.
    if (response.status === 401) return { kind: "unauthenticated" };
    if (response.status === 409) return { kind: "quota_reached" };
    if (response.status !== 201) return { kind: "unavailable" };
    return (await hasBoundedCreateEnvelope(response))
      ? { kind: "success" }
      : { kind: "unavailable" };
  } catch {
    return { kind: "unavailable" };
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abortFromCaller);
  }
}

export interface BotCreationTransport {
  create(signal: AbortSignal): Promise<CreateBotOutcome>;
}

export function createBotCreationTransport(
  options: Omit<CreateBotTransportOptions, "signal"> = {},
): BotCreationTransport {
  return { create: (signal) => createBot({ ...options, signal }) };
}
