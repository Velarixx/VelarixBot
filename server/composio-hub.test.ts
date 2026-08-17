// P2.5 Apps hub API: catalog + connect/disconnect stay on /api/connectors/*,
// enabledApps stays the per-bot gate, bearer is not bypassed. Fake Composio
// MCP only — no live account, no sleeps. Isolated HOME via bootHarness.
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { bootHarness, type BootedHarness } from "./testing/harness.ts";

const KEY = ["ck", "test", "hub", Date.now().toString(36)].join("_");

describe("apps hub connectors (no Composio key)", () => {
  let h: BootedHarness;

  beforeAll(async () => {
    h = await bootHarness({
      instances: { ghost: { driver: "not-a-real-driver", displayName: "Ghost" } },
    });
  }, 30_000);

  afterAll(async () => {
    await h?.stop();
  });

  it("GET /api/connectors/catalog is honest empty when unconfigured", async () => {
    const catalog = await h.api("GET", "/api/connectors/catalog");
    expect(catalog.status).toBe(200);
    expect(catalog.body.configured).toBe(false);
    expect(catalog.body.source).toBe("curated");
    expect(Array.isArray(catalog.body.cards)).toBe(true);
    expect(catalog.body.cards.length).toBeGreaterThan(0);
    expect(catalog.body.cards[0]).toEqual(
      expect.objectContaining({ slug: expect.any(String), label: expect.any(String) }),
    );
    expect(JSON.stringify(catalog.body)).not.toMatch(/ck_|ak_|secret:\/\//);

    const status = await h.api("GET", "/api/connectors");
    expect(status.status).toBe(200);
    expect(status.body).toEqual({ configured: false, services: {} });

    const cfg = await h.api("GET", "/api/config");
    expect(cfg.body.composio).toEqual({ configured: false, apiKeyConfigured: false, connectKeyConfigured: false });
  });

  it("does not bypass the per-launch bearer on catalog, connectors, or bot PATCH", async () => {
    const bot = (await h.api("POST", "/api/bots")).body.bot;
    const denied = await Promise.all([
      fetch(`${h.base}/api/connectors/catalog`),
      fetch(`${h.base}/api/connectors`),
      fetch(`${h.base}/api/connectors/gmail/authorize`, { method: "POST" }),
      fetch(`${h.base}/api/connectors/gmail`, { method: "DELETE" }),
      fetch(`${h.base}/api/bots/${bot.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabledApps: ["gmail"] }),
      }),
    ]);
    for (const res of denied) expect(res.status).toBe(401);

    const wrong = await h.api("PATCH", `/api/bots/${bot.id}`, { enabledApps: ["gmail"] }, { authorization: "Bearer wrong-token" });
    expect(wrong.status).toBe(401);
  });

  it("PATCHes enabledApps for one bot only — empty stays none on the other", async () => {
    const a = (await h.api("POST", "/api/bots")).body.bot;
    const b = (await h.api("POST", "/api/bots")).body.bot;
    const patched = await h.api("PATCH", `/api/bots/${a.id}`, { enabledApps: ["googledrive"] });
    expect(patched.status).toBe(200);
    expect(patched.body.bot.enabledApps).toEqual(["googledrive"]);
    const roster = await h.api("GET", "/api/bots");
    const other = roster.body.bots.find((bot: { id: string }) => bot.id === b.id);
    expect(other?.enabledApps ?? []).toEqual([]);
    expect(roster.body.bots.find((bot: { id: string }) => bot.id === a.id)?.enabledApps).toEqual(["googledrive"]);
  });
});

describe("apps hub connect/disconnect (fake Composio)", () => {
  let stub: Server;
  let stubPort = 0;
  let lastAuth: string | undefined;
  const connected = new Set<string>();
  let h: BootedHarness;

  beforeAll(async () => {
    stub = createServer((req, res) => {
      lastAuth = req.headers["x-consumer-api-key"] as string | undefined;
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        const msg = JSON.parse(data || "{}");
        const args = msg.params?.arguments ?? {};
        const toolkit = args.toolkits?.[0] ?? {};
        const slug = String(toolkit.name ?? "");
        const action = String(toolkit.action ?? "");
        let payload: unknown = {};
        if (action === "add") {
          connected.add(slug);
          payload = { url: `https://connect.composio.dev/auth/${slug}` };
        } else if (action === "list") {
          payload = {
            data: {
              results: {
                [slug]: connected.has(slug)
                  ? { status: "ACTIVE", accounts: [{ id: "acc_1", status: "ACTIVE" }] }
                  : { status: "INITIATED", accounts: [] },
              },
            },
          };
        } else if (action === "remove") {
          connected.delete(slug);
          payload = { removed: true };
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { content: [{ type: "text", text: JSON.stringify(payload) }] },
          }),
        );
      });
    });
    await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
    stubPort = (stub.address() as { port: number }).port;

    h = await bootHarness({
      instances: { ghost: { driver: "not-a-real-driver", displayName: "Ghost" } },
    });
    const saved = await h.api("PUT", "/api/config", {
      composio: { key: KEY, url: `http://127.0.0.1:${stubPort}` },
    });
    expect(saved.status).toBe(200);
    expect(saved.body.composio).toEqual({ configured: true, apiKeyConfigured: false, connectKeyConfigured: true });
    expect(JSON.stringify(saved.body)).not.toContain(KEY);
  }, 30_000);

  afterAll(async () => {
    await h?.stop();
    await new Promise<void>((r) => stub.close(() => r()));
  });

  it("connect and disconnect stay on /api/connectors/* against the fake", async () => {
    const auth = await h.api("POST", "/api/connectors/gmail/authorize");
    expect(auth.status).toBe(200);
    expect(auth.body.url).toBe("https://connect.composio.dev/auth/gmail");
    expect(lastAuth).toBe(KEY);
    expect(JSON.stringify(auth.body)).not.toContain(KEY);

    const on = await h.api("GET", "/api/connectors?services=gmail");
    expect(on.status).toBe(200);
    expect(on.body.configured).toBe(true);
    expect(on.body.services.gmail.connected).toBe(true);
    expect(JSON.stringify(on.body)).not.toContain(KEY);

    const removed = await h.api("DELETE", "/api/connectors/gmail");
    expect(removed.status).toBe(200);
    const off = await h.api("GET", "/api/connectors?services=gmail");
    expect(off.body.services.gmail.connected).toBe(false);
  });
});
