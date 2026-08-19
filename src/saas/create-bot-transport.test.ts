import { describe, expect, it, vi } from "vitest";
import {
  CREATE_BOT_PATH,
  MAX_CREATE_RESPONSE_BYTES,
  createBot,
} from "./create-bot-transport";

function response(body: unknown, status = 201, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

describe("bounded SaaS bot creation transport", () => {
  it("sends exactly the reviewed default-only same-origin request", async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => (
      response({ bot: {
        id: "server-uuid",
        threadId: "internal-thread",
        messages: [{ text: "internal onboarding" }],
        workspace: "internal-workspace",
        provider: { token: "internal-provider" },
      } })
    ));

    await expect(createBot({ fetch })).resolves.toEqual({ kind: "success" });

    expect(fetch).toHaveBeenCalledOnce();
    const [input, init] = fetch.mock.calls[0]!;
    expect(input).toBe(CREATE_BOT_PATH);
    expect(init).toEqual({
      method: "POST",
      body: "{}",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      signal: expect.any(AbortSignal),
    });
    expect(String(init?.body)).not.toMatch(/owner|identity|provider|computer|workspace|model|bot/i);
  });

  it("maps 401 and 409 without parsing or exposing their bodies", async () => {
    await expect(createBot({
      fetch: vi.fn(async () => response("raw session provider detail", 401, { "content-type": "text/plain" })),
    })).resolves.toEqual({ kind: "unauthenticated" });
    await expect(createBot({
      fetch: vi.fn(async () => response("raw quota repository detail", 409, { "content-type": "text/plain" })),
    })).resolves.toEqual({ kind: "quota_reached" });
  });

  it.each([
    ["non-201", response({ error: "raw" }, 500)],
    ["non-JSON", response({ bot: {} }, 201, { "content-type": "text/plain" })],
    ["malformed JSON", response("{")],
    ["missing envelope", response({})],
    ["non-object bot", response({ bot: "raw" })],
    ["extra envelope data", response({ bot: {}, ownerId: "internal" })],
    ["declared oversize", response({ bot: {} }, 201, { "content-length": String(MAX_CREATE_RESPONSE_BYTES + 1) })],
    ["streamed oversize", new Response("x".repeat(MAX_CREATE_RESPONSE_BYTES + 1), {
      status: 201,
      headers: { "content-type": "application/json" },
    })],
  ])("returns one generic failure for %s", async (_name, serverResponse) => {
    await expect(createBot({ fetch: vi.fn(async () => serverResponse) }))
      .resolves.toEqual({ kind: "unavailable" });
  });

  it("maps network, timeout, and caller aborts to the generic failure", async () => {
    await expect(createBot({ fetch: vi.fn(async () => { throw new Error("raw network detail"); }) }))
      .resolves.toEqual({ kind: "unavailable" });

    const pendingFetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("raw timeout detail")));
    }));
    await expect(createBot({ fetch: pendingFetch, timeoutMs: 1 })).resolves.toEqual({ kind: "unavailable" });

    const controller = new AbortController();
    const pending = createBot({ fetch: pendingFetch, signal: controller.signal, timeoutMs: 10_000 });
    controller.abort();
    await expect(pending).resolves.toEqual({ kind: "unavailable" });
  });
});
