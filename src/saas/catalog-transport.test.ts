import { describe, expect, it, vi } from "vitest";
import {
  CATALOG_PATH,
  MAX_CATALOG_ITEMS,
  MAX_CATALOG_RESPONSE_BYTES,
  loadCatalog,
} from "./catalog-transport";

const safeItem = {
  name: "Researcher",
  title: "Research assistant",
  description: "Finds and summarizes evidence.",
  color: "blue",
  messages: [],
  hasMore: false,
};

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

describe("bounded SaaS catalog transport", () => {
  it("uses only the reviewed same-origin read with zero message hydration", async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => json({ bots: [safeItem] }));
    await expect(loadCatalog({ fetch })).resolves.toEqual({
      kind: "success",
      items: [{
        name: safeItem.name,
        title: safeItem.title,
        description: safeItem.description,
        color: safeItem.color,
      }],
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[0]).toBe(CATALOG_PATH);
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      headers: { accept: "application/json" },
    });
  });

  it("treats every 401 as session loss without accepting its body", async () => {
    const response = json({ token: "raw-session-secret", detail: "not parsed" }, 401, {
      "content-type": "text/plain",
    });
    await expect(loadCatalog({ fetch: vi.fn(async () => response) })).resolves.toEqual({
      kind: "unauthenticated",
    });
  });

  it.each([
    ["extra envelope field", { bots: [], ownerId: "123e4567-e89b-42d3-a456-426614174000" }],
    ["bot id", { bots: [{ ...safeItem, id: "123e4567-e89b-42d3-a456-426614174000" }] }],
    ["thread id", { bots: [{ ...safeItem, threadId: "123e4567-e89b-42d3-a456-426614174000" }] }],
    ["workspace data", { bots: [{ ...safeItem, workspace: "private" }] }],
    ["provider state", { bots: [{ ...safeItem, provider: { token: "secret" } }] }],
    ["hydrated messages", { bots: [{ ...safeItem, messages: [{ text: "must not cross" }] }] }],
    ["unknown color", { bots: [{ ...safeItem, color: "url(secret)" }] }],
    ["missing field", { bots: [{ name: "Incomplete" }] }],
  ])("rejects %s rather than projecting a partial response", async (_name, body) => {
    await expect(loadCatalog({ fetch: vi.fn(async () => json(body)) })).resolves.toEqual({ kind: "unavailable" });
  });

  it("rejects non-JSON, malformed JSON, non-success statuses, and too many items", async () => {
    await expect(loadCatalog({ fetch: vi.fn(async () => json({}, 200, { "content-type": "text/plain" })) }))
      .resolves.toEqual({ kind: "unavailable" });
    await expect(loadCatalog({ fetch: vi.fn(async () => json("{")) }))
      .resolves.toEqual({ kind: "unavailable" });
    await expect(loadCatalog({ fetch: vi.fn(async () => json({ error: "raw" }, 503)) }))
      .resolves.toEqual({ kind: "unavailable" });
    await expect(loadCatalog({ fetch: vi.fn(async () => json({ bots: Array(MAX_CATALOG_ITEMS + 1).fill(safeItem) })) }))
      .resolves.toEqual({ kind: "unavailable" });
  });

  it("rejects declared and streamed bodies above the byte cap", async () => {
    const declared = json({ bots: [] }, 200, { "content-length": String(MAX_CATALOG_RESPONSE_BYTES + 1) });
    await expect(loadCatalog({ fetch: vi.fn(async () => declared) })).resolves.toEqual({ kind: "unavailable" });

    const streamed = new Response("x".repeat(MAX_CATALOG_RESPONSE_BYTES + 1), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    await expect(loadCatalog({ fetch: vi.fn(async () => streamed) })).resolves.toEqual({ kind: "unavailable" });
  });

  it("times out and honors component aborts without surfacing raw errors", async () => {
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("raw token cookie provider detail")));
    }));
    await expect(loadCatalog({ fetch, timeoutMs: 1 })).resolves.toEqual({ kind: "unavailable" });

    const controller = new AbortController();
    const pending = loadCatalog({ fetch, signal: controller.signal, timeoutMs: 10_000 });
    controller.abort();
    await expect(pending).resolves.toEqual({ kind: "unavailable" });
  });
});
