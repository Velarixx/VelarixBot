import { describe, expect, it, vi } from "vitest";

import { createDesktopAccessTransport, DESKTOP_ACCESS_PATH } from "./desktop-access-transport";

function response(body: unknown, status: number): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: body === null ? {} : { "content-type": "application/json" },
  });
}

describe("desktop access transport", () => {
  it("uses one same-origin endpoint and accepts only the exact redacted contract", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ access: { expiresAt: 9_000 } }, 200))
      .mockResolvedValueOnce(response({ access: { expiresAt: 10_000 } }, 201))
      .mockResolvedValueOnce(response(null, 204));
    const transport = createDesktopAccessTransport({ fetch: fetcher });
    expect(await transport.check()).toEqual({ kind: "active", expiresAt: 9_000 });
    expect(await transport.request()).toEqual({ kind: "active", expiresAt: 10_000 });
    expect(await transport.revoke()).toBe("revoked");
    expect(fetcher.mock.calls.map(([path, init]) => [path, init.method, init.credentials, init.body])).toEqual([
      [DESKTOP_ACCESS_PATH, "GET", "same-origin", undefined],
      [DESKTOP_ACCESS_PATH, "POST", "same-origin", "{}"],
      [DESKTOP_ACCESS_PATH, "DELETE", "same-origin", undefined],
    ]);
  });

  it("classifies denial, expiry, auth loss, server/network failure, and malformed data", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ error: "denied" }, 403))
      .mockResolvedValueOnce(response({ error: "expired" }, 410))
      .mockResolvedValueOnce(response({ token: "raw-secret" }, 401))
      .mockResolvedValueOnce(response({ error: "provider-secret" }, 500))
      .mockResolvedValueOnce(response({ access: { expiresAt: 1 }, token: "raw-secret" }, 200))
      .mockRejectedValueOnce(new Error("network provider token secret"));
    const transport = createDesktopAccessTransport({ fetch: fetcher });
    expect(await transport.request()).toEqual({ kind: "denied" });
    expect(await transport.check()).toEqual({ kind: "absent" });
    expect(await transport.check()).toEqual({ kind: "unauthenticated" });
    expect(await transport.check()).toEqual({ kind: "unavailable" });
    expect(await transport.check()).toEqual({ kind: "unavailable" });
    expect(await transport.check()).toEqual({ kind: "unavailable" });
  });

  it("bounds a hung request and reports it generically", async () => {
    const fetcher = vi.fn((_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    }));
    const transport = createDesktopAccessTransport({ fetch: fetcher, timeoutMs: 5 });
    expect(await transport.request()).toEqual({ kind: "unavailable" });
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
