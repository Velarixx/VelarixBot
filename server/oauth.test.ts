import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { authenticateApiRequest, type ApplicationAuthentication } from "./auth.ts";
import { openDatabase } from "./db/database.ts";
import type { SqliteDatabase } from "./db/sqlite-native.ts";
import { IdentitySessions, SESSION_COOKIE_NAME } from "./identity.ts";
import {
  createGithubOAuthProvider,
  GithubOAuthProviderError,
  normalizeGithubCallbackUrl,
  resolveGithubOAuthConfiguration,
  type GithubOAuthProvider,
} from "./oauth/github-provider.ts";
import {
  clearOAuthTransactionCookie,
  oauthTransactionCookie,
  oauthTransactionFromCookie,
  OAUTH_TRANSACTION_COOKIE_NAME,
  OAuthTransactionStore,
} from "./oauth/transactions.ts";
import { json, type RouteCtx } from "./routes/context.ts";
import { createOAuthRoutes } from "./routes/oauth.ts";
import { createSessionRoutes } from "./routes/session.ts";

const APPLICATION_ORIGIN = "https://app.velarix.test";
const CALLBACK_URL = `${APPLICATION_ORIGIN}/api/auth/github/callback`;

interface FakeProvider extends GithubOAuthProvider {
  authorizationInputs: Array<{ state: string; codeChallenge: string }>;
  exchangeInputs: Array<{ code: string; codeVerifier: string }>;
  failure: Error | null;
  githubId: number;
}

function fakeProvider(): FakeProvider {
  return {
    authorizationInputs: [],
    exchangeInputs: [],
    failure: null,
    githubId: 42,
    authorizationUrl(input) {
      this.authorizationInputs.push(input);
      const url = new URL("https://github.com/login/oauth/authorize");
      url.searchParams.set("state", input.state);
      url.searchParams.set("code_challenge", input.codeChallenge);
      return url;
    },
    async exchangeCodeForIdentity(input) {
      this.exchangeInputs.push(input);
      if (this.failure) throw this.failure;
      return { githubId: this.githubId, login: "octocat", name: "Octo Cat", avatarUrl: "https://avatars.test/42" };
    },
  };
}

function cookieValue(response: Response, name: string): string | null {
  const header = response.headers.get("set-cookie") ?? "";
  return new RegExp(`(?:^|,\\s*)${name}=([^;,]*)`).exec(header)?.[1] ?? null;
}

describe("OAuth transaction persistence", () => {
  let directory: string;
  let db: SqliteDatabase;
  let store: OAuthTransactionStore;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "velarix-oauth-transaction-"));
    db = openDatabase(join(directory, "oauth.db"));
    store = new OAuthTransactionStore(db);
  });

  afterEach(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("stores digest-bound state/cookie material and atomically prevents replay", () => {
    const transaction = store.create(1_000);
    const row = db.prepare<Record<string, unknown>>("SELECT * FROM github_oauth_transactions").get()!;
    expect(transaction.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(transaction.cookie).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(transaction.codeChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(row)).not.toContain(transaction.state);
    expect(JSON.stringify(row)).not.toContain(transaction.cookie);
    expect(store.consume(transaction.state, transaction.cookie, 2_000)?.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(store.consume(transaction.state, transaction.cookie, 2_001)).toBeNull();
  });

  it("collapses malformed, unknown, mismatched, expired, and ambiguous cookie material", () => {
    const transaction = store.create(1_000);
    expect(store.consume(undefined, transaction.cookie, 2_000)).toBeNull();
    expect(store.consume("short", transaction.cookie, 2_000)).toBeNull();
    expect(store.consume("A".repeat(43), transaction.cookie, 2_000)).toBeNull();
    expect(store.consume(transaction.state, "B".repeat(43), 2_000)).toBeNull();
    expect(store.consume(transaction.state, transaction.cookie, 601_000)).toBeNull();
    expect(oauthTransactionFromCookie(`${OAUTH_TRANSACTION_COOKIE_NAME}=${transaction.cookie}; ${OAUTH_TRANSACTION_COOKIE_NAME}=${transaction.cookie}`)).toBeNull();
  });

  it("uses one Secure HttpOnly SameSite=Lax Path=/ cookie shape for set and clear", () => {
    const token = "A".repeat(43);
    expect(oauthTransactionCookie(token)).toBe(
      `${OAUTH_TRANSACTION_COOKIE_NAME}=${token}; Max-Age=600; HttpOnly; SameSite=Lax; Path=/; Secure`,
    );
    expect(clearOAuthTransactionCookie()).toBe(
      `${OAUTH_TRANSACTION_COOKIE_NAME}=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax; Path=/; Secure`,
    );
  });
});

describe("GitHub OAuth provider boundary", () => {
  const config = {
    clientId: "client-id",
    clientSecret: "top-secret-client-value",
    applicationOrigin: APPLICATION_ORIGIN,
    callbackUrl: CALLBACK_URL,
  };

  it("fails closed for missing credentials and non-exact callback URLs without echoing values", () => {
    expect(() => resolveGithubOAuthConfiguration(APPLICATION_ORIGIN, {})).toThrow(/CLIENT_ID/);
    expect(() => resolveGithubOAuthConfiguration(APPLICATION_ORIGIN, {
      VELARIX_GITHUB_CLIENT_ID: "id",
      VELARIX_GITHUB_CLIENT_SECRET: "secret",
      VELARIX_GITHUB_CALLBACK_URL: "http://app.velarix.test/api/auth/github/callback",
    })).toThrow("exact HTTPS callback URL");
    expect(() => normalizeGithubCallbackUrl(`${CALLBACK_URL}?return=https://evil.test`, APPLICATION_ORIGIN)).toThrow(
      "exact HTTPS callback URL",
    );
  });

  it("builds the exact GitHub handoff with callback, state, S256 PKCE, and identity scope", () => {
    const provider = createGithubOAuthProvider(config);
    const url = provider.authorizationUrl({ state: "s".repeat(43), codeChallenge: "c".repeat(43) });
    expect(`${url.origin}${url.pathname}`).toBe("https://github.com/login/oauth/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "client-id",
      redirect_uri: CALLBACK_URL,
      scope: "read:user",
      state: "s".repeat(43),
      code_challenge: "c".repeat(43),
      code_challenge_method: "S256",
    });
    expect(url.href).not.toContain(config.clientSecret);
  });

  it("exchanges internally and returns only the four allowlisted profile fields", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      requests.push({ url: String(input), init });
      if (requests.length === 1) {
        return new Response(JSON.stringify({ access_token: "provider-access-token", token_type: "bearer" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({ id: 77, login: "hub-user", name: "Hub User", avatar_url: "https://avatars.test/77", email: "discard@test", private: "discard" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const provider = createGithubOAuthProvider(config, fakeFetch);
    await expect(provider.exchangeCodeForIdentity({ code: "provider-code", codeVerifier: "v".repeat(43) })).resolves.toEqual({
      githubId: 77,
      login: "hub-user",
      name: "Hub User",
      avatarUrl: "https://avatars.test/77",
    });
    expect(requests).toHaveLength(2);
    expect(String(requests[0].init?.body)).toContain("code_verifier=");
    expect((requests[1].init?.headers as Record<string, string>).authorization).toBe("Bearer provider-access-token");
  });

  it("normalizes status, content-type, oversized, and malformed provider failures", async () => {
    const cases: Response[] = [
      new Response("no", { status: 500, headers: { "content-type": "application/json" } }),
      new Response("{}", { status: 200, headers: { "content-type": "text/plain" } }),
      new Response("x".repeat(65 * 1024), { status: 200, headers: { "content-type": "application/json" } }),
      new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
    ];
    for (const response of cases) {
      const provider = createGithubOAuthProvider(config, async () => response);
      const error = await provider.exchangeCodeForIdentity({ code: "code", codeVerifier: "v".repeat(43) }).catch((value) => value);
      expect(error).toBeInstanceOf(GithubOAuthProviderError);
      expect(String(error)).not.toContain(config.clientSecret);
    }
  });
});

describe("SaaS OAuth routes", () => {
  let directory: string;
  let db: SqliteDatabase;
  let sessions: IdentitySessions;
  let transactions: OAuthTransactionStore;
  let provider: FakeProvider;
  let server: Server;
  let base: string;
  let now: number;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "velarix-oauth-routes-"));
    db = openDatabase(join(directory, "oauth.db"));
    sessions = new IdentitySessions(db);
    transactions = new OAuthTransactionStore(db);
    provider = fakeProvider();
    now = 10_000;
    const authentication: ApplicationAuthentication = {
      mode: "saas",
      applicationOrigin: APPLICATION_ORIGIN,
      sessions,
      now: () => now,
    };
    const routes = [
      createOAuthRoutes({ applicationOrigin: APPLICATION_ORIGIN, provider, transactions, sessions, now: () => now }),
      createSessionRoutes(),
    ];
    server = createServer((req, res) => {
      void (async () => {
        const url = new URL(req.url ?? "/", "http://localhost");
        const ctx: RouteCtx = { req, res, url, path: url.pathname, method: req.method ?? "GET" };
        const decision = authenticateApiRequest(
          {
            path: ctx.path,
            method: ctx.method,
            headers: {
              authorization: req.headers.authorization,
              cookie: req.headers.cookie,
              host: req.headers.host,
              origin: typeof req.headers.origin === "string" ? req.headers.origin : undefined,
            },
          },
          authentication,
        );
        if (!decision.ok) return json(res, decision.failure.status, { error: decision.failure.error });
        if (decision.principal) ctx.principal = decision.principal;
        for (const route of routes) if (await route(ctx)) return;
        json(res, 404, { error: "not found" });
      })().catch(() => json(res, 500, { error: "internal error" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  async function start(suffix = ""): Promise<{ response: Response; state: string; cookie: string }> {
    const response = await fetch(`${base}/api/auth/github/start${suffix}`, { redirect: "manual" });
    const location = new URL(response.headers.get("location")!);
    return {
      response,
      state: location.searchParams.get("state")!,
      cookie: cookieValue(response, OAUTH_TRANSACTION_COOKIE_NAME)!,
    };
  }

  async function callback(query: string, cookie: string): Promise<Response> {
    return fetch(`${base}/api/auth/github/callback?${query}`, {
      redirect: "manual",
      headers: { cookie: `${OAUTH_TRANSACTION_COOKIE_NAME}=${cookie}` },
    });
  }

  it("completes start, callback, session probe, and idempotent current-session sign-out", async () => {
    const begun = await start("?returnUrl=https://evil.test/steal");
    expect(begun.response.status).toBe(302);
    expect(new URL(begun.response.headers.get("location")!).origin).toBe("https://github.com");
    expect(begun.response.headers.get("location")).not.toContain("evil.test");
    expect(begun.response.headers.get("set-cookie")).toContain("Secure");

    const completed = await callback(`state=${begun.state}&code=good&returnUrl=https://evil.test`, begun.cookie);
    expect(completed.status).toBe(303);
    expect(completed.headers.get("location")).toBe(`${APPLICATION_ORIGIN}/auth/result?outcome=authenticated`);
    const sessionToken = cookieValue(completed, SESSION_COOKIE_NAME)!;
    expect(sessionToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const probe = await fetch(`${base}/api/session`, { headers: { cookie: `${SESSION_COOKIE_NAME}=${sessionToken}` } });
    expect(probe.status).toBe(200);
    const firstUser = (await probe.json()) as { user: { id: string } };
    const otherSession = sessions.createSession(firstUser.user.id, { now, maxAgeSeconds: 3_600 }).token;

    const signedOut = await fetch(`${base}/api/auth/sign-out`, {
      method: "POST",
      headers: { cookie: `${SESSION_COOKIE_NAME}=${sessionToken}`, origin: APPLICATION_ORIGIN },
    });
    expect(signedOut.status).toBe(204);
    expect(signedOut.headers.get("cache-control")).toBe("no-store");
    expect(signedOut.headers.get("set-cookie")).toContain("Max-Age=0");
    const repeated = await fetch(`${base}/api/auth/sign-out`, {
      method: "POST",
      headers: { cookie: `${SESSION_COOKIE_NAME}=${sessionToken}`, origin: APPLICATION_ORIGIN },
    });
    expect(repeated.status).toBe(204);
    expect((await fetch(`${base}/api/session`, { headers: { cookie: `${SESSION_COOKIE_NAME}=${sessionToken}` } })).status).toBe(401);
    expect((await fetch(`${base}/api/session`, { headers: { cookie: `${SESSION_COOKIE_NAME}=${otherSession}` } })).status).toBe(200);

    const again = await start();
    const second = await callback(`state=${again.state}&code=again`, again.cookie);
    const secondToken = cookieValue(second, SESSION_COOKIE_NAME)!;
    const secondProbe = await fetch(`${base}/api/session`, { headers: { cookie: `${SESSION_COOKIE_NAME}=${secondToken}` } });
    expect(((await secondProbe.json()) as { user: { id: string } }).user.id).toBe(firstUser.user.id);
  });

  it("collapses missing, ambiguous, tampered, expired, unknown, and replayed state", async () => {
    const outcome = `${APPLICATION_ORIGIN}/auth/result?outcome=callback_rejected`;
    const missing = await start();
    expect((await callback("code=x", missing.cookie)).headers.get("location")).toBe(outcome);

    const ambiguous = await start();
    expect((await callback(`state=${ambiguous.state}&state=${ambiguous.state}&code=x`, ambiguous.cookie)).headers.get("location")).toBe(outcome);

    const tampered = await start();
    expect((await callback(`state=${"A".repeat(43)}&code=x`, tampered.cookie)).headers.get("location")).toBe(outcome);

    const expired = await start();
    now += 600_000;
    expect((await callback(`state=${expired.state}&code=x`, expired.cookie)).headers.get("location")).toBe(outcome);

    const unknown = await start();
    expect((await callback(`state=${unknown.state}&code=x`, "B".repeat(43))).headers.get("location")).toBe(outcome);

    const replay = await start();
    const query = `state=${replay.state}&code=x`;
    expect((await callback(query, replay.cookie)).headers.get("location")).toContain("outcome=authenticated");
    expect((await callback(query, replay.cookie)).headers.get("location")).toBe(outcome);
    expect(provider.exchangeInputs).toHaveLength(1);
    expect(db.prepare<{ n: number }>("SELECT count(*) AS n FROM sessions").get()?.n).toBe(1);
  });

  it("normalizes provider denial, exchange/profile failure, duplicate code, and secrets", async () => {
    const denied = await start();
    const denialResponse = await callback(`state=${denied.state}&error=access_denied&error_description=secret-provider-detail`, denied.cookie);
    expect(denialResponse.headers.get("location")).toBe(`${APPLICATION_ORIGIN}/auth/result?outcome=sign_in_declined`);

    const duplicate = await start();
    const duplicateResponse = await callback(`state=${duplicate.state}&code=one&code=two`, duplicate.cookie);
    expect(duplicateResponse.headers.get("location")).toBe(`${APPLICATION_ORIGIN}/auth/result?outcome=callback_rejected`);

    for (const stage of ["exchange", "profile"] as const) {
      provider.failure = new Error(`provider-${stage}-secret-token`);
      const begun = await start();
      const response = await callback(`state=${begun.state}&code=${stage}`, begun.cookie);
      const serialized = `${response.status} ${response.headers.get("location")} ${response.headers.get("set-cookie")}`;
      expect(response.headers.get("location")).toBe(`${APPLICATION_ORIGIN}/auth/result?outcome=service_unavailable`);
      expect(serialized).not.toMatch(/provider-(exchange|profile)-secret-token|error_description|access_denied/);
    }
  });

  it("requires exact Origin for sign-out while every other unauthenticated API remains gated", async () => {
    for (const origin of [undefined, "http://app.velarix.test", "https://evil.test", `${APPLICATION_ORIGIN}:444`]) {
      const response = await fetch(`${base}/api/auth/sign-out`, {
        method: "POST",
        headers: origin ? { origin } : {},
      });
      expect(response.status, origin).toBe(403);
    }
    expect((await fetch(`${base}/api/auth/sign-out`, { method: "POST", headers: { origin: APPLICATION_ORIGIN } })).status).toBe(204);
    expect((await fetch(`${base}/api/session`)).status).toBe(401);
    expect((await fetch(`${base}/api/bots`)).status).toBe(401);
    expect((await fetch(`${base}/api/auth/github/start`, { method: "POST" })).status).toBe(401);
  });
});
