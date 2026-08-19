import { describe, expect, it, vi } from "vitest";
import {
  AUTHORIZATION_RESULT_PATH,
  GITHUB_SIGN_IN_START_PATH,
  SESSION_PROBE_PATH,
  SIGN_OUT_PATH,
  beginGithubAuthorization,
  consumeAuthorizationResult,
  normalizeSessionResponse,
  probeSession,
  probeSessionWithBoundedRetry,
  readAuthorizationResult,
  signOut,
  type AuthorizationLocation,
} from "./session-transport";

function json(body: unknown, status = 200, contentType = "application/json; charset=utf-8"): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": contentType },
  });
}

function location(overrides: Partial<AuthorizationLocation> = {}): AuthorizationLocation {
  return {
    pathname: AUTHORIZATION_RESULT_PATH,
    search: "?outcome=authenticated",
    hash: "",
    assign: vi.fn(),
    replace: vi.fn(),
    ...overrides,
  };
}

describe("same-origin session transport", () => {
  it("accepts only the exact reviewed session success and discards the UUID", async () => {
    const outcome = await normalizeSessionResponse(json({ user: { id: "123e4567-e89b-42d3-a456-426614174000" } }));
    expect(outcome).toBe("authenticated");
    expect(outcome).not.toContain("123e4567");
  });

  it.each([
    ["network", null],
    ["404", json({ error: "not found" }, 404)],
    ["405", json({ error: "wrong method" }, 405)],
    ["5xx", json({ error: "provider-secret-detail" }, 503)],
    ["malformed json", json("{", 200)],
    ["unexpected content type", json({ user: { id: "123e4567-e89b-42d3-a456-426614174000" } }, 200, "text/plain")],
  ])("fails closed on %s", async (_name, response) => {
    const fetch = response
      ? vi.fn(async () => response)
      : vi.fn(async () => { throw new Error("raw network detail"); });
    await expect(probeSession({ fetch })).resolves.toBe("unavailable");
  });

  it.each([
    {},
    { user: null },
    { user: { id: "not-a-uuid" } },
    { user: { id: "123e4567-e89b-42d3-a456-426614174000", login: "must-not-cross" } },
    { user: { id: "123e4567-e89b-42d3-a456-426614174000" }, token: "must-not-cross" },
  ])("rejects malformed success shape %#", async (body) => {
    await expect(normalizeSessionResponse(json(body))).resolves.toBe("unavailable");
  });

  it("accepts only the reviewed uniform 401 shape", async () => {
    await expect(normalizeSessionResponse(json({ error: "unauthorized" }, 401))).resolves.toBe("unauthenticated");
    await expect(normalizeSessionResponse(json({ error: "expired" }, 401))).resolves.toBe("unavailable");
    await expect(normalizeSessionResponse(json({ error: "unauthorized", detail: "raw" }, 401))).resolves.toBe("unavailable");
  });

  it("times out without returning or logging raw errors", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("sensitive timeout detail")));
    }));
    await expect(probeSession({ fetch, timeoutMs: 1 })).resolves.toBe("unavailable");
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it("uses browser-managed credentials and the fixed probe path", async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => json({ error: "unauthorized" }, 401));
    await probeSession({ fetch });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0]).toBe(SESSION_PROBE_PATH);
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
    });
  });

  it("retries an unavailable probe once, but never retries a resolved 401", async () => {
    const recovered = vi.fn()
      .mockResolvedValueOnce(json({ error: "temporary" }, 503))
      .mockResolvedValueOnce(json({ user: { id: "123e4567-e89b-42d3-a456-426614174000" } }));
    const wait = vi.fn(async () => undefined);
    await expect(probeSessionWithBoundedRetry({ fetch: recovered }, wait)).resolves.toBe("authenticated");
    expect(recovered).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledOnce();

    const unauthenticated = vi.fn(async () => json({ error: "unauthorized" }, 401));
    await expect(probeSessionWithBoundedRetry({ fetch: unauthenticated }, wait)).resolves.toBe("unauthenticated");
    expect(unauthenticated).toHaveBeenCalledOnce();
  });

  it("starts authorization only at the reviewed fixed endpoint", () => {
    const navigate = vi.fn();
    expect(beginGithubAuthorization(navigate)).toBe("started");
    expect(navigate).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith(GITHUB_SIGN_IN_START_PATH);
    const failing = vi.fn(() => { throw new Error("raw navigation detail"); });
    expect(beginGithubAuthorization(failing)).toBe("unavailable");
  });

  it.each(["authenticated", "sign_in_declined", "callback_rejected", "service_unavailable"] as const)(
    "allowlists the returned %s outcome",
    (outcome) => {
      expect(readAuthorizationResult(location({ search: `?outcome=${outcome}` }))).toBe(outcome);
    },
  );

  it("collapses unknown or malformed callback results and ignores outcome parameters elsewhere", () => {
    expect(readAuthorizationResult(location({ search: "?outcome=unknown" }))).toBe("callback_rejected");
    expect(readAuthorizationResult(location({ search: "?outcome=authenticated&outcome=authenticated" }))).toBe("callback_rejected");
    expect(readAuthorizationResult(location({ search: "?outcome=authenticated&code=secret" }))).toBe("callback_rejected");
    expect(readAuthorizationResult(location({ hash: "#state=secret" }))).toBe("callback_rejected");
    expect(readAuthorizationResult(location({ pathname: "/", search: "?outcome=authenticated" }))).toBe("none");
  });

  it("scrubs the result URL synchronously before returning an outcome", () => {
    const calls: string[] = [];
    const history = { replaceState: vi.fn(() => calls.push("scrubbed")) };
    const consumed = consumeAuthorizationResult(location(), history);
    calls.push(`returned:${consumed.outcome}`);
    expect(calls).toEqual(["scrubbed", "returned:authenticated"]);
    expect(history.replaceState).toHaveBeenCalledWith(null, "", "/");
    expect(consumed.scrubbed).toBe(true);
  });

  it("navigates to a clean root and suppresses the result if history cleanup fails", () => {
    const current = location();
    const consumed = consumeAuthorizationResult(current, {
      replaceState: () => { throw new Error("history unavailable"); },
    });
    expect(current.replace).toHaveBeenCalledWith("/");
    expect(consumed).toEqual({ outcome: "none", scrubbed: false });
  });

  it("uses one fixed idempotent sign-out request and accepts only 204", async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 204 }));
    await expect(signOut({ fetch })).resolves.toBe("confirmed");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0]).toBe(SIGN_OUT_PATH);
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
    });
    await expect(signOut({ fetch: vi.fn(async () => json({ error: "forbidden" }, 403)) })).resolves.toBe("unconfirmed");
  });
});
