// Per-launch API capability: unit coverage for the pure gate helpers plus
// an e2e leg against the real harness server (401 without / with a wrong or
// stale token, SSE requires the token, /api/health stays open and minimal,
// Host and Origin hardening, and COMMS_TOKEN staying a separate credential).
//
// Local-first continuity (this WP): a second same-machine client attaches
// with the existing sidecar bearer. Listen stays 127.0.0.1; LOOPBACK_HOSTS
// stays loopback-only; /api/health stays four keys and unauthenticated;
// every other /api/* including GET /api/events requires Bearer.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  hostAllowed,
  isAuthExempt,
  LOOPBACK_HOSTS,
  originAllowed,
  requireApiAuth,
  resolveApiToken,
  tokenMatches,
} from "./auth.ts";
import { readServiceAuth, writeServiceAuth } from "../electron/service-auth.mjs";
import { connectSse, bootHarness, type BootedHarness } from "./testing/harness.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

describe("resolveApiToken", () => {
  it("prefers the injected token, then the dev token, else mints 256 bits", () => {
    expect(resolveApiToken({ VELARIX_API_TOKEN: "inj", VELARIX_DEV_TOKEN: "dev" })).toBe("inj");
    expect(resolveApiToken({ VELARIX_DEV_TOKEN: "dev" })).toBe("dev");
    const minted = resolveApiToken({});
    expect(minted).toMatch(/^[0-9a-f]{64}$/); // 32 bytes hex — nobody else holds it
    expect(resolveApiToken({})).not.toBe(minted);
  });

  it("never treats a blank env var as auth-off", () => {
    const token = resolveApiToken({ VELARIX_DEV_TOKEN: "   " });
    expect(token.trim()).toBe(token);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenMatches("Bearer ", token)).toBe(false);
    expect(tokenMatches(undefined, "")).toBe(false);
  });
});

describe("tokenMatches", () => {
  it("accepts only the exact bearer token", () => {
    expect(tokenMatches("Bearer sekrit", "sekrit")).toBe(true);
    expect(tokenMatches("bearer sekrit", "sekrit")).toBe(true);
    expect(tokenMatches("Bearer wrong", "sekrit")).toBe(false);
    expect(tokenMatches("Bearer sekrit-stale", "sekrit")).toBe(false);
    expect(tokenMatches("sekrit", "sekrit")).toBe(false);
    expect(tokenMatches(undefined, "sekrit")).toBe(false);
  });
});

describe("host and origin hardening", () => {
  it("LOOPBACK_HOSTS stays the three loopback names — no LAN, no phone, no CORS origin", () => {
    expect([...LOOPBACK_HOSTS].sort()).toEqual(["127.0.0.1", "[::1]", "localhost"]);
    expect(LOOPBACK_HOSTS.size).toBe(3);
    expect(LOOPBACK_HOSTS.has("0.0.0.0")).toBe(false);
    expect(LOOPBACK_HOSTS.has("::")).toBe(false);
    expect(LOOPBACK_HOSTS.has("192.168.1.1")).toBe(false);
    expect(LOOPBACK_HOSTS.has("10.0.0.1")).toBe(false);
    const authSrc = read("server/auth.ts");
    expect(authSrc).not.toMatch(/Access-Control-Allow-Origin/i);
    expect(authSrc).toMatch(/new Set\(\["127\.0\.0\.1", "localhost", "\[::1\]"\]\)/);
  });

  it("hostAllowed pins the loopback bind (DNS-rebinding guard)", () => {
    expect(hostAllowed("127.0.0.1:8799", 8799)).toBe(true);
    expect(hostAllowed("localhost:8799", 8799)).toBe(true);
    expect(hostAllowed("[::1]:8799", 8799)).toBe(true);
    expect(hostAllowed("127.0.0.1", 8799)).toBe(true); // default-port form
    expect(hostAllowed("127.0.0.1:9999", 8799)).toBe(false);
    expect(hostAllowed("evil.example:8799", 8799)).toBe(false);
    expect(hostAllowed("velarix.attacker.tld", 8799)).toBe(false);
    expect(hostAllowed("192.168.1.10:8799", 8799)).toBe(false);
    expect(hostAllowed("10.0.0.5:8799", 8799)).toBe(false);
    expect(hostAllowed("0.0.0.0:8799", 8799)).toBe(false);
    expect(hostAllowed("[::]:8799", 8799)).toBe(false);
    expect(hostAllowed(undefined, 8799)).toBe(false);
  });

  it("originAllowed rejects browser origins that are not loopback", () => {
    expect(originAllowed(undefined)).toBe(true); // node clients / same-origin fetch
    expect(originAllowed("http://127.0.0.1:8799")).toBe(true);
    expect(originAllowed("http://localhost:5199")).toBe(true);
    expect(originAllowed("http://[::1]:8799")).toBe(true);
    expect(originAllowed("https://evil.example")).toBe(false);
    expect(originAllowed("http://192.168.1.10:8799")).toBe(false);
    expect(originAllowed("http://10.0.0.5:5199")).toBe(false);
    expect(originAllowed("null")).toBe(false);
    expect(originAllowed("file://x")).toBe(false);
    expect(originAllowed("not a url")).toBe(false);
  });

  it("pins server.listen host to 127.0.0.1 with no host-env bind", () => {
    const src = read("server/index.ts");
    expect(src).toMatch(/server\.listen\(PORT, "127\.0\.0\.1"/);
    expect(src).not.toMatch(/0\.0\.0\.0/);
    expect(src).not.toMatch(/listen\([^)]*process\.env/);
    expect(src).not.toMatch(/Access-Control-Allow-Origin/i);
  });

  it("SECURITY.md keeps off-machine reachability a vulnerability and documents sidecar bearer", () => {
    const security = read("SECURITY.md");
    expect(security).toMatch(/off-machine/);
    expect(security).toMatch(/vulnerability/);
    expect(security).toMatch(/Authorization: Bearer/);
    expect(security).toMatch(/service-auth\.json/);
    expect(security).not.toMatch(/no authentication by design/);
    expect(security).toMatch(/phone or other host/);
    expect(security).toMatch(/out of scope/);
    for (const tree of ["ios", "android", "mobile", "companion", "tailscale", "ngrok", "cloudflared"]) {
      expect(existsSync(join(ROOT, tree))).toBe(false);
    }
  });
});

describe("requireApiAuth", () => {
  const TOKEN = "tok-123";
  const ok = { authorization: `Bearer ${TOKEN}`, host: "127.0.0.1:8799" };

  it("exempts only /api/health — SSE and every other /api/* stay gated", () => {
    expect(isAuthExempt("/api/health")).toBe(true);
    expect(isAuthExempt("/api/bots")).toBe(false);
    expect(isAuthExempt("/api/routines")).toBe(false);
    expect(isAuthExempt("/api/webhooks")).toBe(false);
    expect(isAuthExempt("/api/events")).toBe(false);
    expect(isAuthExempt("/api/events/snapshot")).toBe(false);
    expect(isAuthExempt("/api/instances")).toBe(false);
    expect(isAuthExempt("/api/config")).toBe(false);
    expect(requireApiAuth({ path: "/api/health", method: "GET", headers: {} }, TOKEN, 8799)).toBeNull();
    expect(
      requireApiAuth({ path: "/api/events", method: "GET", headers: { host: ok.host } }, TOKEN, 8799),
    ).toMatchObject({ status: 401 });
    expect(requireApiAuth({ path: "/api/events", method: "GET", headers: ok }, TOKEN, 8799)).toBeNull();
  });

  it("401s a missing/wrong token and 403s a bad host or origin", () => {
    expect(requireApiAuth({ path: "/api/bots", method: "GET", headers: ok }, TOKEN, 8799)).toBeNull();
    expect(requireApiAuth({ path: "/api/bots", method: "GET", headers: { host: ok.host } }, TOKEN, 8799)).toMatchObject({ status: 401 });
    expect(
      requireApiAuth({ path: "/api/bots", method: "GET", headers: { ...ok, authorization: "Bearer nope" } }, TOKEN, 8799),
    ).toMatchObject({ status: 401 });
    expect(
      requireApiAuth({ path: "/api/bots", method: "GET", headers: { ...ok, host: "evil.example" } }, TOKEN, 8799),
    ).toMatchObject({ status: 403 });
    expect(
      requireApiAuth({ path: "/api/bots", method: "POST", headers: { ...ok, origin: "https://evil.example" } }, TOKEN, 8799),
    ).toMatchObject({ status: 403 });
    expect(
      requireApiAuth({ path: "/api/bots", method: "POST", headers: { ...ok, origin: "http://127.0.0.1:5199" } }, TOKEN, 8799),
    ).toBeNull();
    // GETs from a foreign origin carry no state change — token still required
    expect(
      requireApiAuth({ path: "/api/bots", method: "GET", headers: { ...ok, origin: "https://evil.example" } }, TOKEN, 8799),
    ).toBeNull();
  });
});

describe("API auth e2e (real harness server)", () => {
  const COMMS_TOKEN = "test-auth-comms-token";
  let h: BootedHarness;

  /** Raw node:http request so we can spoof headers fetch() forbids (Host). */
  function rawRequest(path: string, headers: Record<string, string>, method = "GET"): Promise<{ status: number }> {
    const url = new URL(h.base);
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        { host: url.hostname, port: url.port, path, method, headers },
        (res) => {
          res.resume();
          res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
        },
      );
      req.on("error", reject);
      req.end();
    });
  }

  beforeAll(async () => {
    h = await bootHarness({
      env: { OMB_COMMS_TOKEN: COMMS_TOKEN },
      instances: { ghost: { driver: "not-a-real-driver", displayName: "Ghost" } },
    });
  }, 30_000);

  afterAll(async () => {
    await h?.stop();
  });

  it("401s /api/* without, with a wrong, and with a stale token", async () => {
    const bare = await fetch(`${h.base}/api/bots`);
    expect(bare.status).toBe(401);
    const wrong = await h.api("GET", "/api/bots", undefined, { authorization: "Bearer wrong-token" });
    expect(wrong.status).toBe(401);
    const stale = await h.api("GET", "/api/bots", undefined, {
      authorization: `Bearer ${h.token}-from-a-previous-launch`,
    });
    expect(stale.status).toBe(401);
    const good = await h.api("GET", "/api/bots");
    expect(good.status).toBe(200);
    const post = await fetch(`${h.base}/api/bots`, { method: "POST" });
    expect(post.status).toBe(401);
    const routinesDenied = await fetch(`${h.base}/api/routines`);
    expect(routinesDenied.status).toBe(401);
    const routinesWrong = await h.api("GET", "/api/routines", undefined, { authorization: "Bearer wrong-token" });
    expect(routinesWrong.status).toBe(401);
    const bot = (await h.api("GET", "/api/bots")).body.bots[0];
    for (const action of ["start", "stop", "save", "discard"]) {
      const denied = await fetch(`${h.base}/api/bots/${bot.id}/teach/${action}`, { method: "POST" });
      expect(denied.status).toBe(401);
    }
  });

  it("keeps /api/health open and minimal (port-fallback identity probe)", async () => {
    const res = await fetch(`${h.base}/api/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["app", "pid", "stamp", "static"]);
    expect(body.app).toBe("velarixbot");
    expect(body).not.toHaveProperty("token");
    expect(JSON.stringify(body)).not.toContain(h.token);
    expect(JSON.stringify(body)).not.toMatch(/Bearer|VELARIX_API_TOKEN|service-auth/i);
  });

  it("requires the token on every /api/* other than /api/health, including SSE", async () => {
    const gated = [
      "/api/bots",
      "/api/routines",
      "/api/instances",
      "/api/config",
      "/api/events",
      "/api/events/snapshot",
      "/api/diagnostics/export",
    ];
    for (const path of gated) {
      const denied = await fetch(`${h.base}${path}`);
      expect(denied.status, path).toBe(401);
      expect(denied.headers.get("access-control-allow-origin")).toBeNull();
    }
    const allowed = await fetch(`${h.base}/api/events`, {
      headers: { authorization: `Bearer ${h.token}` },
    });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("content-type")).toContain("text/event-stream");
    expect(allowed.headers.get("access-control-allow-origin")).toBeNull();
    await allowed.body?.cancel();
  });

  it("second same-machine client attaches via sidecar bearer (health + SSE)", async () => {
    expect(h.base.startsWith("http://127.0.0.1:")).toBe(true);
    const healthRes = await fetch(`${h.base}/api/health`);
    expect(healthRes.status).toBe(200);
    const health = (await healthRes.json()) as { app: string; pid: number; static: boolean; stamp: string };
    expect(Object.keys(health).sort()).toEqual(["app", "pid", "stamp", "static"]);
    expect(JSON.stringify(health)).not.toContain(h.token);

    const port = Number(new URL(h.base).port);
    const sidecarPath = join(h.home, ".velarixbot", "service-auth.json");
    writeFileSync(
      sidecarPath,
      `${JSON.stringify({ app: "velarixbot", pid: health.pid, port, token: h.token }, null, 2)}\n`,
      { mode: 0o600 },
    );
    const sidecar = JSON.parse(readFileSync(sidecarPath, "utf8")) as {
      app: string;
      pid: number;
      port: number;
      token: string;
    };
    expect(sidecar).toEqual({ app: "velarixbot", pid: health.pid, port, token: h.token });

    // second client: probe health (no auth), then subscribe with the sidecar token
    const probe = await fetch(`${h.base}/api/health`);
    expect(probe.status).toBe(200);
    const probeBody = (await probe.json()) as Record<string, unknown>;
    expect(Object.keys(probeBody).sort()).toEqual(["app", "pid", "stamp", "static"]);
    expect(JSON.stringify(probeBody)).not.toContain(sidecar!.token);

    const denied = await fetch(`${h.base}/api/events`);
    expect(denied.status).toBe(401);

    const sse = await connectSse(h.base, sidecar.token);
    const hello = await sse.until((f) => f.kind === "hello");
    expect(hello.kind).toBe("hello");
    expect(JSON.stringify(hello)).not.toContain(sidecar.token);
    expect(JSON.stringify(hello)).not.toMatch(/Bearer|VELARIX_API_TOKEN/i);
    expect(hello).not.toHaveProperty("token");
    sse.close();

    // pin the packaged sidecar helpers against this HOME (256-bit hex, not COMMS)
    const hex = `${"ab".repeat(16)}${"cd".repeat(16)}`;
    writeServiceAuth({ pid: health.pid, port, token: hex }, h.home);
    expect(readServiceAuth(h.home)).toEqual({ app: "velarixbot", pid: health.pid, port, token: hex });
    expect(hex).not.toBe(COMMS_TOKEN);
    expect(hex).not.toBe(h.token);
  });

  it("rejects a spoofed Host (403) and a browser Origin on state changes (403)", async () => {
    const spoofed = await rawRequest("/api/bots", {
      host: "velarix.attacker.tld",
      authorization: `Bearer ${h.token}`,
    });
    expect(spoofed.status).toBe(403);
    const crossOrigin = await h.api("POST", "/api/bots", undefined, { origin: "https://evil.example" });
    expect(crossOrigin.status).toBe(403);
    const sameOrigin = await h.api("POST", "/api/bots", undefined, { origin: h.base });
    expect(sameOrigin.status).toBe(201);
  });

  it("keeps COMMS_TOKEN and the API token as separate credentials", async () => {
    expect(COMMS_TOKEN).not.toBe(h.token);
    // the public token never opens the internal surface …
    const internal = await h.api("GET", "/api/internal/agents?self=x");
    expect(internal.status).toBe(401);
    const internalOk = await h.api("GET", "/api/internal/agents?self=x", undefined, {
      authorization: `Bearer ${COMMS_TOKEN}`,
    });
    expect(internalOk.status).toBe(200);
    // … and the comms token never opens the public surface
    const publicWithComms = await h.api("GET", "/api/bots", undefined, {
      authorization: `Bearer ${COMMS_TOKEN}`,
    });
    expect(publicWithComms.status).toBe(401);
  });
});
