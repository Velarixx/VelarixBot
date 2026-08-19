import type { GithubIdentity } from "../identity.ts";

export const GITHUB_AUTHORIZE_ORIGIN = "https://github.com";
export const GITHUB_AUTHORIZE_PATH = "/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_PROFILE_URL = "https://api.github.com/user";
const RESPONSE_LIMIT_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 5_000;

export interface GithubOAuthProvider {
  authorizationUrl(input: { state: string; codeChallenge: string }): URL;
  exchangeCodeForIdentity(input: { code: string; codeVerifier: string }): Promise<GithubIdentity>;
}

export interface GithubOAuthConfiguration {
  clientId: string;
  clientSecret: string;
  applicationOrigin: string;
  callbackUrl: string;
}

export class GithubOAuthProviderError extends Error {
  readonly stage: "exchange" | "profile";

  constructor(stage: "exchange" | "profile") {
    super(`GitHub OAuth ${stage} failed`);
    this.name = "GithubOAuthProviderError";
    this.stage = stage;
  }
}

function requiredCredential(value: string | undefined, name: string): string {
  const normalized = value?.trim() ?? "";
  if (!normalized || normalized.length > 1_024 || /[\s\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new Error(`${name} must be configured`);
  }
  return normalized;
}

export function normalizeGithubCallbackUrl(value: string | undefined, applicationOrigin: string): string {
  const configured = value?.trim() ?? "";
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new Error("VELARIX_GITHUB_CALLBACK_URL must be the exact HTTPS callback URL");
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    url.search !== "" ||
    url.origin !== applicationOrigin ||
    url.pathname !== "/api/auth/github/callback" ||
    configured !== url.href
  ) {
    throw new Error("VELARIX_GITHUB_CALLBACK_URL must be the exact HTTPS callback URL");
  }
  return configured;
}

export function resolveGithubOAuthConfiguration(
  applicationOrigin: string,
  env: Record<string, string | undefined> = process.env,
): GithubOAuthConfiguration {
  return {
    clientId: requiredCredential(env.VELARIX_GITHUB_CLIENT_ID, "VELARIX_GITHUB_CLIENT_ID"),
    clientSecret: requiredCredential(env.VELARIX_GITHUB_CLIENT_SECRET, "VELARIX_GITHUB_CLIENT_SECRET"),
    applicationOrigin,
    callbackUrl: normalizeGithubCallbackUrl(env.VELARIX_GITHUB_CALLBACK_URL, applicationOrigin),
  };
}

async function boundedJson(response: Response, stage: "exchange" | "profile"): Promise<Record<string, unknown>> {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  const declaredLength = Number(response.headers.get("content-length"));
  if (
    !response.ok ||
    contentType !== "application/json" ||
    (Number.isFinite(declaredLength) && declaredLength > RESPONSE_LIMIT_BYTES) ||
    !response.body
  ) {
    throw new GithubOAuthProviderError(stage);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > RESPONSE_LIMIT_BYTES) throw new GithubOAuthProviderError(stage);
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof GithubOAuthProviderError) throw error;
    throw new GithubOAuthProviderError(stage);
  } finally {
    reader.releaseLock();
  }

  try {
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid JSON object");
    return value as Record<string, unknown>;
  } catch {
    throw new GithubOAuthProviderError(stage);
  }
}

function validOauthValue(value: string): boolean {
  return value.length >= 1 && value.length <= 1_024 && !/[\s\u0000-\u001f\u007f]/u.test(value);
}

export function createGithubOAuthProvider(
  config: GithubOAuthConfiguration,
  fetchImplementation: typeof fetch = fetch,
): GithubOAuthProvider {
  return {
    authorizationUrl({ state, codeChallenge }) {
      if (!validOauthValue(state) || !validOauthValue(codeChallenge)) {
        throw new TypeError("OAuth authorization parameters are malformed");
      }
      const url = new URL(GITHUB_AUTHORIZE_PATH, GITHUB_AUTHORIZE_ORIGIN);
      url.searchParams.set("client_id", config.clientId);
      url.searchParams.set("redirect_uri", config.callbackUrl);
      url.searchParams.set("scope", "read:user");
      url.searchParams.set("state", state);
      url.searchParams.set("code_challenge", codeChallenge);
      url.searchParams.set("code_challenge_method", "S256");
      return url;
    },

    async exchangeCodeForIdentity({ code, codeVerifier }) {
      if (!validOauthValue(code) || !validOauthValue(codeVerifier)) {
        throw new GithubOAuthProviderError("exchange");
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      let tokenBody: Record<string, unknown>;
      try {
        const response = await fetchImplementation(GITHUB_TOKEN_URL, {
          method: "POST",
          redirect: "error",
          signal: controller.signal,
          headers: {
            accept: "application/json",
            "content-type": "application/x-www-form-urlencoded",
            "user-agent": "VelarixBot",
          },
          body: new URLSearchParams({
            client_id: config.clientId,
            client_secret: config.clientSecret,
            code,
            redirect_uri: config.callbackUrl,
            code_verifier: codeVerifier,
          }),
        });
        tokenBody = await boundedJson(response, "exchange");
      } catch (error) {
        if (error instanceof GithubOAuthProviderError) throw error;
        throw new GithubOAuthProviderError("exchange");
      } finally {
        clearTimeout(timeout);
      }

      const accessToken = tokenBody.access_token;
      if (typeof accessToken !== "string" || !validOauthValue(accessToken)) {
        throw new GithubOAuthProviderError("exchange");
      }

      const profileController = new AbortController();
      const profileTimeout = setTimeout(() => profileController.abort(), REQUEST_TIMEOUT_MS);
      let profile: Record<string, unknown>;
      try {
        const response = await fetchImplementation(GITHUB_PROFILE_URL, {
          method: "GET",
          redirect: "error",
          signal: profileController.signal,
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${accessToken}`,
            "user-agent": "VelarixBot",
            "x-github-api-version": "2022-11-28",
          },
        });
        profile = await boundedJson(response, "profile");
      } catch (error) {
        if (error instanceof GithubOAuthProviderError) throw error;
        throw new GithubOAuthProviderError("profile");
      } finally {
        clearTimeout(profileTimeout);
      }

      const id = profile.id;
      const login = profile.login;
      const name = profile.name;
      const avatarUrl = profile.avatar_url;
      if (
        !Number.isSafeInteger(id) ||
        Number(id) <= 0 ||
        typeof login !== "string" ||
        login.trim().length < 1 ||
        login.trim().length > 255 ||
        (name !== null && name !== undefined && typeof name !== "string") ||
        (avatarUrl !== null && avatarUrl !== undefined && typeof avatarUrl !== "string")
      ) {
        throw new GithubOAuthProviderError("profile");
      }
      return {
        githubId: Number(id),
        login,
        name: typeof name === "string" ? name : null,
        avatarUrl: typeof avatarUrl === "string" ? avatarUrl : null,
      };
    },
  };
}
