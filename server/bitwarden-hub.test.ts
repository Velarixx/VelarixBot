// Bitwarden settings + status HTTP surface. Fake SM only. Isolated HOME.
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { encryptCatalogForTests } from "./bitwarden.ts";
import { encryptEncString, parseAccessToken } from "./bitwarden-crypto.ts";
import { bootHarness, type BootedHarness } from "./testing/harness.ts";

function canary(tag: string): string {
  return ["fake", tag, "canary", Date.now().toString(36), Math.random().toString(36).slice(2)].join("-");
}

function testAccessToken(): string {
  const secret = Buffer.from("fedcba9876543210");
  return ["0", "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff", "hubClientSecretValue"].join(".") + `:${secret.toString("base64")}`;
}

describe("Bitwarden SM settings hub", () => {
  let stub: Server;
  let h: BootedHarness;
  let token: string;
  let secretValue: string;

  beforeAll(async () => {
    token = testAccessToken();
    secretValue = canary("hub-value");
    const orgKey = Buffer.alloc(64, 5);
    const parsed = parseAccessToken(token);
    const payload = encryptEncString(JSON.stringify({ encryptionKey: orgKey.toString("base64") }), parsed.encryptionKey);
    stub = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const write = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
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
          data: [
            { id: "sec-hub", projectId: "proj-hub", ...encryptCatalogForTests(orgKey, { key: "HUB_KEY", value: secretValue }) },
          ],
        });
        return;
      }
      if (req.method === "GET" && url.pathname === "/projects") {
        write(200, { data: [{ id: "proj-hub", name: encryptEncString("Hub Project", orgKey) }] });
        return;
      }
      write(404, { error: "not found" });
    });
    await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
    const port = (stub.address() as { port: number }).port;
    h = await bootHarness({
      instances: { ghost: { driver: "not-a-real-driver", displayName: "Ghost" } },
    });
    const saved = await h.api("PUT", "/api/config", {
      bitwarden: {
        accessToken: token,
        identityUrl: `http://127.0.0.1:${port}`,
        apiUrl: `http://127.0.0.1:${port}`,
      },
    });
    expect(saved.status).toBe(200);
    expect(saved.body.bitwarden).toEqual({ configured: true });
    expect(JSON.stringify(saved.body)).not.toContain(token);
    expect(JSON.stringify(saved.body)).not.toContain(secretValue);
  }, 30_000);

  afterAll(async () => {
    await h?.stop();
    await new Promise<void>((resolve) => stub.close(() => resolve()));
  });

  it("GET /api/bitwarden is connected with names only — never values or the token", async () => {
    const status = await h.api("GET", "/api/bitwarden");
    expect(status.status).toBe(200);
    expect(status.body.status).toBe("connected");
    expect(status.body.nextStep).toMatch(/Approve|Disconnect/i);
    expect(status.body.secrets[0]).toEqual(expect.objectContaining({ id: "sec-hub", key: "HUB_KEY" }));
    expect(status.body.projects[0]).toEqual(expect.objectContaining({ id: "proj-hub", name: "Hub Project" }));
    expect(JSON.stringify(status.body)).not.toContain(token);
    expect(JSON.stringify(status.body)).not.toContain(secretValue);
    const disk = readFileSync(join(h.home, ".velarixbot", "config.json"), "utf8");
    expect(disk).not.toContain(token);
    expect(JSON.parse(disk).bitwarden.accessToken).toBe("secret://bitwarden.accessToken");
  });

  it("does not bypass the per-launch bearer", async () => {
    const denied = await Promise.all([
      fetch(`${h.base}/api/bitwarden`),
      fetch(`${h.base}/api/bitwarden/disconnect`, { method: "POST" }),
    ]);
    for (const res of denied) expect(res.status).toBe(401);
  });

  it("PATCHes per-bot allowlists — empty stays none on the other bot", async () => {
    const a = (await h.api("POST", "/api/bots")).body.bot;
    const b = (await h.api("POST", "/api/bots")).body.bot;
    const patched = await h.api("PATCH", `/api/bots/${a.id}`, { bitwardenSecretIds: ["sec-hub"], bitwardenProjectIds: ["proj-hub"] });
    expect(patched.status).toBe(200);
    expect(patched.body.bot.bitwardenSecretIds).toEqual(["sec-hub"]);
    expect(patched.body.bot.bitwardenProjectIds).toEqual(["proj-hub"]);
    expect(JSON.stringify(patched.body)).not.toContain(secretValue);
    const roster = await h.api("GET", "/api/bots");
    const other = roster.body.bots.find((bot: { id: string }) => bot.id === b.id);
    expect(other?.bitwardenSecretIds ?? []).toEqual([]);
    expect(other?.bitwardenProjectIds ?? []).toEqual([]);
  });

  it("disconnect clears the token in-process without a reinstall", async () => {
    const cut = await h.api("POST", "/api/bitwarden/disconnect");
    expect(cut.status).toBe(200);
    expect(cut.body.status).toBe("disconnected");
    expect(cut.body.configured).toBe(false);
    expect(JSON.stringify(cut.body)).not.toContain(token);
    const cfg = await h.api("GET", "/api/config");
    expect(cfg.body.bitwarden).toEqual({ configured: false });
    const status = await h.api("GET", "/api/bitwarden");
    expect(status.body.status).toBe("disconnected");
    expect(status.body.nextStep).toMatch(/App Settings|access token/i);
  });
});
