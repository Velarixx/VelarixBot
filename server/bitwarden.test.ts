// Bitwarden SM: persist write-only, default-deny per bot, values never
// echoed, disconnect/revoke fail closed. Isolated HOME. Fake SM HTTP only.
import { createServer, type Server } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  approvedSecretEnv,
  bitwardenAllowlist,
  bitwardenStatus,
  dropBitwardenSession,
  encryptCatalogForTests,
  fetchApprovedSecretEnv,
  fetchApprovedSecrets,
  isSecretApproved,
  parseBitwardenIdList,
  resetBitwardenForTests,
  secretEnvName,
} from "./bitwarden.ts";
import { decryptEncStringUtf8, encryptEncString, parseAccessToken } from "./bitwarden-crypto.ts";
import { DATA_DIR, ensureDirs, loadConfig, saveConfig } from "./config.ts";
import { EventBus } from "./harness/bus.ts";
import { redactRegisteredSecrets, redactSecrets } from "./redact-text.ts";
import { initSecretStore } from "./secrets.ts";

function canary(tag: string): string {
  return ["fake", tag, "canary", Date.now().toString(36), Math.random().toString(36).slice(2)].join("-");
}

function testAccessToken(): string {
  const secret = Buffer.from("0123456789abcdef");
  return ["0", "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", "testClientSecretValue"].join(".") + `:${secret.toString("base64")}`;
}

function startFakeSm(opts: {
  token: string;
  orgKey: Buffer;
  secrets: Array<{ id: string; key: string; value: string; projectId?: string }>;
  projects: Array<{ id: string; name: string }>;
  revoked?: () => boolean;
}): Promise<{ server: Server; identityUrl: string; apiUrl: string; port: number }> {
  const parsed = parseAccessToken(opts.token);
  const payload = encryptEncString(JSON.stringify({ encryptionKey: opts.orgKey.toString("base64") }), parsed.encryptionKey);
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const write = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (opts.revoked?.() && url.pathname !== "/connect/token") {
      write(401, { error: "revoked" });
      return;
    }
    if (req.method === "POST" && url.pathname === "/connect/token") {
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
      });
      req.on("end", () => {
        const form = new URLSearchParams(raw);
        if (form.get("client_id") !== parsed.accessTokenId || form.get("client_secret") !== parsed.clientSecret) {
          write(401, { error: "invalid_client" });
          return;
        }
        write(200, { access_token: "header.payload.sig", encrypted_payload: payload });
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/secrets") {
      write(200, {
        data: opts.secrets.map((secret) => ({
          id: secret.id,
          projectId: secret.projectId,
          ...encryptCatalogForTests(opts.orgKey, { key: secret.key, value: secret.value }),
        })),
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/projects") {
      write(200, {
        data: opts.projects.map((project) => ({
          id: project.id,
          name: encryptEncString(project.name, opts.orgKey),
        })),
      });
      return;
    }
    write(404, { error: "not found" });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("fake SM did not bind");
      const base = `http://127.0.0.1:${address.port}`;
      resolve({ server, identityUrl: base, apiUrl: base, port: address.port });
    });
  });
}

describe("bitwarden allowlist helpers", () => {
  it("defaults to none and only matches explicit secret or project ids", () => {
    expect(bitwardenAllowlist({})).toEqual({ secretIds: [], projectIds: [] });
    expect(parseBitwardenIdList([" a ", "", "a", "b"])).toEqual(["a", "b"]);
    expect(isSecretApproved({ id: "s1", projectId: "p1" }, { secretIds: [], projectIds: [] })).toBe(false);
    expect(isSecretApproved({ id: "s1", projectId: "p1" }, { secretIds: ["s1"], projectIds: [] })).toBe(true);
    expect(isSecretApproved({ id: "s2", projectId: "p1" }, { secretIds: [], projectIds: ["p1"] })).toBe(true);
    expect(isSecretApproved({ id: "s2", projectId: "p9" }, { secretIds: ["s1"], projectIds: ["p1"] })).toBe(false);
  });

  it("builds env names from keys without injecting the access token", () => {
    expect(secretEnvName("db url", "id-1")).toBe("DB_URL");
    const env = approvedSecretEnv([
      { id: "1", key: "DATABASE_URL", value: "postgres://x" },
      { id: "2", key: "BWS_ACCESS_TOKEN", value: "must-not-win" },
    ]);
    expect(env.DATABASE_URL).toBe("postgres://x");
    expect(env.BWS_ACCESS_TOKEN).toBeUndefined();
  });
});

describe("bitwarden settings persist + scoped fetch", () => {
  const posixOnly = process.platform === "win32" ? it.skip : it;
  let stub: Awaited<ReturnType<typeof startFakeSm>>;
  let token: string;
  let orgKey: Buffer;
  let secretValue: string;
  let revoked = false;

  beforeEach(async () => {
    resetBitwardenForTests();
    ensureDirs();
    await initSecretStore();
    token = testAccessToken();
    orgKey = Buffer.alloc(64, 3);
    secretValue = canary("bws-value");
    revoked = false;
    stub = await startFakeSm({
      token,
      orgKey,
      revoked: () => revoked,
      projects: [{ id: "proj-1", name: "Payments" }],
      secrets: [
        { id: "sec-allowed", key: "STRIPE_KEY", value: secretValue, projectId: "proj-1" },
        { id: "sec-other", key: "OTHER_KEY", value: canary("other"), projectId: "proj-2" },
      ],
    });
  });

  afterEach(async () => {
    resetBitwardenForTests();
    await new Promise<void>((resolve) => stub.server.close(() => resolve()));
  });

  it("saves the access token write-only and reports disconnected until configured", async () => {
    expect((await bitwardenStatus({})).status).toBe("disconnected");
    await saveConfig({ bitwarden: { accessToken: token, identityUrl: stub.identityUrl, apiUrl: stub.apiUrl } });
    const raw = readFileSync(join(DATA_DIR, "config.json"), "utf8");
    expect(raw).not.toContain(token);
    expect(JSON.parse(raw).bitwarden.accessToken).toBe("secret://bitwarden.accessToken");
    const cfg = loadConfig();
    expect(cfg.bitwarden?.accessToken).toBe(token);
    const status = await bitwardenStatus(cfg);
    expect(status.status).toBe("connected");
    expect(status.configured).toBe(true);
    expect(JSON.stringify(status)).not.toContain(token);
    expect(JSON.stringify(status)).not.toContain(secretValue);
    expect(status.secrets.map((s) => s.key)).toEqual(expect.arrayContaining(["STRIPE_KEY", "OTHER_KEY"]));
    expect(status.projects[0]?.name).toBe("Payments");
  });

  posixOnly("keeps config.json 0600 after a Bitwarden save — POSIX-only: Windows has no Unix mode bits", async () => {
    await saveConfig({ bitwarden: { accessToken: token, identityUrl: stub.identityUrl, apiUrl: stub.apiUrl } });
    expect(statSync(join(DATA_DIR, "config.json")).mode & 0o777).toBe(0o600);
    expect(existsSync(join(DATA_DIR, "secrets.json"))).toBe(true);
    expect(statSync(join(DATA_DIR, "secrets.json")).mode & 0o777).toBe(0o600);
  });

  it("default-deny: empty allowlist gets no values; only explicit ids are injected", async () => {
    await saveConfig({ bitwarden: { accessToken: token, identityUrl: stub.identityUrl, apiUrl: stub.apiUrl } });
    const cfg = loadConfig();
    expect(await fetchApprovedSecrets(cfg, {})).toEqual([]);
    expect(await fetchApprovedSecrets(cfg, { bitwardenSecretIds: [], bitwardenProjectIds: [] })).toEqual([]);
    const one = await fetchApprovedSecretEnv(cfg, { bitwardenSecretIds: ["sec-allowed"] });
    expect(one.env.STRIPE_KEY).toBe(secretValue);
    expect(one.keys).toEqual(["STRIPE_KEY"]);
    const project = await fetchApprovedSecrets(cfg, { bitwardenProjectIds: ["proj-1"] });
    expect(project.map((s) => s.id)).toEqual(["sec-allowed"]);
    const none = await fetchApprovedSecrets(cfg, { bitwardenSecretIds: ["sec-missing"] });
    expect(none).toEqual([]);
  });

  it("never puts secret values in status, logs, or event payloads", async () => {
    await saveConfig({ bitwarden: { accessToken: token, identityUrl: stub.identityUrl, apiUrl: stub.apiUrl } });
    const cfg = loadConfig();
    await fetchApprovedSecrets(cfg, { bitwardenSecretIds: ["sec-allowed"] });
    expect(redactSecrets(`export STRIPE_KEY=${secretValue}`)).toContain("[redacted]");
    expect(redactRegisteredSecrets(secretValue)).toBe("[redacted]");
    const bus = new EventBus();
    const seen: unknown[] = [];
    bus.subscribe((event) => seen.push(event));
    bus.publish({
      eventId: "e1",
      provider: "fake",
      threadId: "t1",
      createdAt: new Date().toISOString(),
      type: "content.delta",
      text: `leaked ${secretValue}`,
    } as never);
    expect(JSON.stringify(seen)).not.toContain(secretValue);
    expect(JSON.stringify(seen)).toContain("[redacted]");
  });

  it("disconnect and revoke fail closed on the next fetch without a reinstall", async () => {
    await saveConfig({ bitwarden: { accessToken: token, identityUrl: stub.identityUrl, apiUrl: stub.apiUrl } });
    let cfg = loadConfig();
    expect((await fetchApprovedSecretEnv(cfg, { bitwardenSecretIds: ["sec-allowed"] })).env.STRIPE_KEY).toBe(secretValue);

    dropBitwardenSession();
    await saveConfig({ bitwarden: { accessToken: "" } });
    cfg = loadConfig();
    expect(cfg.bitwarden?.accessToken).toBeUndefined();
    expect((await bitwardenStatus(cfg)).status).toBe("disconnected");
    expect(await fetchApprovedSecrets(cfg, { bitwardenSecretIds: ["sec-allowed"] })).toEqual([]);
    expect(redactRegisteredSecrets(secretValue)).toBe(secretValue);

    await saveConfig({ bitwarden: { accessToken: token, identityUrl: stub.identityUrl, apiUrl: stub.apiUrl } });
    cfg = loadConfig();
    expect((await fetchApprovedSecretEnv(cfg, { bitwardenSecretIds: ["sec-allowed"] })).env.STRIPE_KEY).toBe(secretValue);
    revoked = true;
    dropBitwardenSession();
    await expect(fetchApprovedSecrets(cfg, { bitwardenSecretIds: ["sec-allowed"] })).rejects.toThrow(/rejected the access token|HTTP 401/);
  });
});

describe("enc string decrypt helper stays local to tests", () => {
  it("does not leak plaintext through encryptCatalogForTests", () => {
    const orgKey = Buffer.alloc(64, 9);
    const value = canary("plain");
    const enc = encryptCatalogForTests(orgKey, { key: "NAME", value });
    expect(enc.value).not.toContain(value);
    expect(decryptEncStringUtf8(enc.value, orgKey)).toBe(value);
  });
});
