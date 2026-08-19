import type { GithubOAuthProvider } from "../oauth/github-provider.ts";
import { GITHUB_AUTHORIZE_ORIGIN, GITHUB_AUTHORIZE_PATH } from "../oauth/github-provider.ts";
import {
  AUTH_RESULT_PATH,
  GITHUB_OAUTH_CALLBACK_PATH,
  GITHUB_OAUTH_START_PATH,
  SIGN_OUT_PATH,
} from "../oauth/paths.ts";
import {
  clearOAuthTransactionCookie,
  oauthTransactionCookie,
  oauthTransactionFromCookie,
  type OAuthTransactionStore,
} from "../oauth/transactions.ts";
import {
  clearSessionCookie,
  MAX_SESSION_AGE_SECONDS,
  sessionCookie,
  sessionTokenFromCookie,
  type CompletedGithubSignIn,
  type GithubIdentity,
} from "../identity.ts";
import type { SecurityAuditRecorder } from "../services/security-audit.ts";
import type { RouteHandler } from "./context.ts";

type PublicOAuthOutcome = "authenticated" | "sign_in_declined" | "callback_rejected" | "service_unavailable";

export interface OAuthIdentitySessions {
  completeGithubSignIn(
    githubIdentity: GithubIdentity,
    options?: { now?: number; maxAgeSeconds?: number },
  ): CompletedGithubSignIn;
  revokeSession(token: unknown, now?: number): boolean;
}

export interface CreateOAuthRoutesInput {
  applicationOrigin: string;
  provider: GithubOAuthProvider;
  transactions: OAuthTransactionStore;
  sessions: OAuthIdentitySessions;
  audit: SecurityAuditRecorder;
  now?: () => number;
}

function singleQueryValue(url: URL, name: string): string | null {
  const values = url.searchParams.getAll(name);
  return values.length === 1 && values[0] !== "" ? values[0] : null;
}

function redirect(res: Parameters<RouteHandler>[0]["res"], location: string, setCookie?: string | string[]): void {
  res.statusCode = 303;
  res.setHeader("location", location);
  res.setHeader("cache-control", "no-store");
  if (setCookie) res.setHeader("set-cookie", setCookie);
  res.end();
}

export function createOAuthRoutes(input: CreateOAuthRoutesInput): RouteHandler {
  const now = input.now ?? (() => Date.now());
  const result = (outcome: PublicOAuthOutcome): string => {
    const url = new URL(AUTH_RESULT_PATH, input.applicationOrigin);
    url.searchParams.set("outcome", outcome);
    return url.href;
  };

  return async ({ req, res, url, path, method }) => {
    if (method === "GET" && path === GITHUB_OAUTH_START_PATH) {
      const transaction = input.transactions.create(now());
      let authorizationUrl: URL;
      try {
        authorizationUrl = input.provider.authorizationUrl({
          state: transaction.state,
          codeChallenge: transaction.codeChallenge,
        });
      } catch {
        input.audit.recordSystem({ action: "oauth.start", decision: "deny", reason: "provider_failure" });
        throw new Error("OAuth provider could not create an authorization URL");
      }
      if (
        authorizationUrl.origin !== GITHUB_AUTHORIZE_ORIGIN ||
        authorizationUrl.pathname !== GITHUB_AUTHORIZE_PATH ||
        authorizationUrl.protocol !== "https:" ||
        authorizationUrl.username !== "" ||
        authorizationUrl.password !== "" ||
        authorizationUrl.hash !== ""
      ) {
        input.audit.recordSystem({ action: "oauth.start", decision: "deny", reason: "provider_failure" });
        throw new Error("OAuth provider returned an invalid authorization URL");
      }
      input.audit.recordSystem({ action: "oauth.start", decision: "allow", reason: "initiated" });
      res.statusCode = 302;
      res.setHeader("location", authorizationUrl.href);
      res.setHeader("cache-control", "no-store");
      res.setHeader("set-cookie", oauthTransactionCookie(transaction.cookie));
      res.end();
      return true;
    }

    if (method === "GET" && path === GITHUB_OAUTH_CALLBACK_PATH) {
      const clearTransaction = clearOAuthTransactionCookie();
      const state = singleQueryValue(url, "state");
      const cookie = oauthTransactionFromCookie(req.headers.cookie);
      const transaction = input.transactions.consume(state, cookie, now());
      if (!transaction) {
        input.audit.recordSystem({ action: "oauth.callback", decision: "deny", reason: "invalid_transaction" });
        redirect(res, result("callback_rejected"), clearTransaction);
        return true;
      }

      const error = singleQueryValue(url, "error");
      const code = singleQueryValue(url, "code");
      if (error && !code) {
        input.audit.recordSystem({ action: "oauth.callback", decision: "deny", reason: "provider_declined" });
        redirect(res, result("sign_in_declined"), clearTransaction);
        return true;
      }
      if (!code || error) {
        input.audit.recordSystem({ action: "oauth.callback", decision: "deny", reason: "malformed_callback" });
        redirect(res, result("callback_rejected"), clearTransaction);
        return true;
      }

      let identity: GithubIdentity;
      try {
        identity = await input.provider.exchangeCodeForIdentity({
          code,
          codeVerifier: transaction.codeVerifier,
        });
      } catch {
        input.audit.recordSystem({ action: "oauth.callback", decision: "deny", reason: "provider_failure" });
        redirect(res, result("service_unavailable"), clearTransaction);
        return true;
      }

      try {
        const { session } = input.sessions.completeGithubSignIn(identity, {
          now: now(),
          maxAgeSeconds: MAX_SESSION_AGE_SECONDS,
        });
        redirect(res, result("authenticated"), [
          clearTransaction,
          sessionCookie(session.token, MAX_SESSION_AGE_SECONDS, "saas"),
        ]);
      } catch {
        input.audit.recordSystem({ action: "oauth.callback", decision: "deny", reason: "internal_failure" });
        redirect(res, result("service_unavailable"), clearTransaction);
      }
      return true;
    }

    if (method === "POST" && path === SIGN_OUT_PATH) {
      input.sessions.revokeSession(sessionTokenFromCookie(req.headers.cookie), now());
      res.statusCode = 204;
      res.setHeader("cache-control", "no-store");
      res.setHeader("set-cookie", clearSessionCookie("saas"));
      res.end();
      return true;
    }

    return false;
  };
}
