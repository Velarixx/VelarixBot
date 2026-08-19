import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { openDatabase } from "./db/database.ts";
import { IdentitySessions, SESSION_COOKIE_NAME } from "./identity.ts";
import {
  bestEffortRm,
  harnessEnv,
  SERVER_ENTRY,
  stopChild,
  TESTING_DIR,
  waitForHealth,
  writeHarnessConfig,
} from "./testing/harness.ts";

describe("SaaS authenticated request boundary", () => {
  const applicationOrigin = "https://app.velarix.test";
  const commsToken = "saas-test-comms-token";
  const desktopToken = "saas-test-desktop-token";
  let home: string;
  let base: string;
  let child: ChildProcess;
  let stderr = "";
  let userId: string;
  let activeToken: string;
  let expiredToken: string;
  let revokedToken: string;

  const cookie = (token: string) => `${SESSION_COOKIE_NAME}=${token}`;
  const get = (path: string, headers: Record<string, string> = {}) => fetch(`${base}${path}`, { headers });
  const post = (origin?: string) =>
    fetch(`${base}/api/session`, {
      method: "POST",
      headers: {
        cookie: cookie(activeToken),
        ...(origin === undefined ? {} : { origin }),
      },
    });

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "velarix-saas-auth-"));
    writeHarnessConfig(home, {});
    const db = openDatabase(join(home, ".velarixbot", "velarixbot.db"));
    const identity = new IdentitySessions(db);
    const now = Date.now();
    const user = identity.upsertGithubIdentity({ githubId: 24, login: "boundary-test" }, now - 10_000);
    userId = user.id;
    activeToken = identity.createSession(user.id, { now: now - 1_000, maxAgeSeconds: 3_600 }).token;
    expiredToken = identity.createSession(user.id, { now: now - 10_000, maxAgeSeconds: 1 }).token;
    revokedToken = identity.createSession(user.id, { now: now - 1_000, maxAgeSeconds: 3_600 }).token;
    identity.revokeSession(revokedToken, now);
    db.close();

    const port = 28_000 + Math.floor(Math.random() * 4_000);
    base = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, [SERVER_ENTRY], {
      cwd: join(TESTING_DIR, "..", ".."),
      env: harnessEnv(home, {
        OMB_PORT: String(port),
        OMB_COMMS_TOKEN: commsToken,
        VELARIX_DEV_TOKEN: desktopToken,
        VELARIX_AUTH_MODE: "saas",
        VELARIX_APP_ORIGIN: applicationOrigin,
        VELARIX_GITHUB_CLIENT_ID: "test-client-id",
        VELARIX_GITHUB_CLIENT_SECRET: "test-client-secret",
        VELARIX_GITHUB_CALLBACK_URL: `${applicationOrigin}/api/auth/github/callback`,
      }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", (chunk) => (stderr += chunk));
    await waitForHealth(base, child, () => stderr);
  }, 30_000);

  afterAll(async () => {
    await stopChild(child);
    bestEffortRm(home);
  });

  it("returns the same minimal 401 for every invalid session class and bearer fallback attempt", async () => {
    const headers: Array<Record<string, string>> = [
      {},
      { cookie: cookie("short") },
      { cookie: cookie("A".repeat(43)) },
      { cookie: cookie(expiredToken) },
      { cookie: cookie(revokedToken) },
      { cookie: `${cookie(activeToken)}; ${cookie(activeToken)}` },
      { authorization: `Bearer ${desktopToken}` },
      { authorization: `Bearer ${commsToken}` },
    ];
    for (const credential of headers) {
      const response = await get("/api/session", credential);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "unauthorized" });
    }
  });

  it("mounts only the SaaS OAuth entry pairs and keeps redirects fixed and secret-free", async () => {
    const start = await fetch(`${base}/api/auth/github/start?returnUrl=https://evil.test/steal`, {
      redirect: "manual",
    });
    expect(start.status).toBe(302);
    const authorization = new URL(start.headers.get("location")!);
    expect(`${authorization.origin}${authorization.pathname}`).toBe("https://github.com/login/oauth/authorize");
    expect(authorization.searchParams.get("redirect_uri")).toBe(
      `${applicationOrigin}/api/auth/github/callback`,
    );
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorization.href).not.toContain("evil.test");
    expect(authorization.href).not.toContain("test-client-secret");

    const rejected = await fetch(`${base}/api/auth/github/callback?code=missing-state`, {
      redirect: "manual",
    });
    expect(rejected.status).toBe(303);
    expect(rejected.headers.get("location")).toBe(
      `${applicationOrigin}/auth/result?outcome=callback_rejected`,
    );
    expect(rejected.headers.get("set-cookie")).toContain("velarix_oauth_tx=; Max-Age=0");

    expect((await fetch(`${base}/api/auth/github/start`, { method: "POST" })).status).toBe(401);
    expect((await fetch(`${base}/api/session?path=/api/auth/github/start`)).status).toBe(401);
  });

  it("projects only the authenticated internal UUID and does not expose secrets", async () => {
    const response = await get("/api/session", { cookie: cookie(activeToken) });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body).toEqual({ user: { id: userId } });
    const serialized = JSON.stringify(body);
    for (const secret of [activeToken, expiredToken, revokedToken, desktopToken, commsToken]) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).not.toMatch(/cookie|digest|github|provider|token/i);
  });

  it("rejects every Origin variant before state-changing route dispatch", async () => {
    for (const origin of [
      undefined,
      "http://app.velarix.test",
      "https://velarix.test",
      "https://sub.app.velarix.test",
      "https://app.velarix.test:444",
      "not a url",
    ]) {
      const response = await post(origin);
      expect(response.status, String(origin)).toBe(403);
      expect(await response.json()).toEqual({ error: "forbidden origin" });
    }
    const exact = await post(applicationOrigin);
    expect(exact.status).toBe(404);
  });

  it("makes sign-out exact-Origin and idempotently safe without a current session", async () => {
    const wrong = await fetch(`${base}/api/auth/sign-out`, {
      method: "POST",
      headers: { origin: "https://evil.test" },
    });
    expect(wrong.status).toBe(403);
    expect(await wrong.json()).toEqual({ error: "forbidden origin" });

    for (const credential of [undefined, cookie("short"), cookie(revokedToken)]) {
      const response = await fetch(`${base}/api/auth/sign-out`, {
        method: "POST",
        headers: {
          origin: applicationOrigin,
          ...(credential ? { cookie: credential } : {}),
        },
      });
      expect(response.status).toBe(204);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("set-cookie")).toContain("velarix_session=; Max-Age=0");
      expect(await response.text()).toBe("");
    }
  });

  it("exposes only the SaaS catalog and does not merge desktop or COMMS boundaries", async () => {
    const catalog = await get("/api/bots", { cookie: cookie(activeToken) });
    expect(catalog.status).toBe(200);
    expect(await catalog.json()).toEqual({ bots: [] });

    const desktopBusiness = await get("/api/routines", { cookie: cookie(activeToken) });
    expect(desktopBusiness.status).toBe(404);

    const internalWithSession = await get("/api/internal/agents?self=x", { cookie: cookie(activeToken) });
    expect(internalWithSession.status).toBe(401);
    const internalWithComms = await get("/api/internal/agents?self=x", {
      authorization: `Bearer ${commsToken}`,
    });
    expect(internalWithComms.status).toBe(200);
  });
});
