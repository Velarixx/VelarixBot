// Priority 5 on the Sessions path: health + stale-auth + collisions against
// a fake v3.1 backend. No live Composio, no sleeps, isolated HOME.
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { bootHarness, type BootedHarness } from "./testing/harness.ts";

const API_KEY = ["ak", "test", "health", Date.now().toString(36)].join("_");

function startFakeV31(): Promise<{
  server: Server;
  port: number;
}> {
  const accounts: any[] = [
    { id: "acc_mail_1", toolkit: { slug: "gmail" }, status: "EXPIRED" },
    { id: "acc_mail_2", toolkit: { slug: "gmail" }, status: "ACTIVE" },
  ];
  const server = createServer((req, res) => {
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.headers["x-api-key"] !== API_KEY) return json(401, { error: "unauthorized" });
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/connected_accounts" && req.method === "GET") {
        const userId = url.searchParams.get("user_ids") ?? "";
        const slugs = (url.searchParams.get("toolkit_slugs") ?? "").split(",").filter(Boolean);
        const items = accounts.filter((a) => {
          if (slugs.length && !slugs.includes(String(a.toolkit.slug))) return false;
          return Boolean(userId);
        });
        return json(200, { items });
      }
      json(404, { error: "nope" });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, port });
    });
  });
}

describe("connector health on Sessions (fake v3.1)", () => {
  let stub: Awaited<ReturnType<typeof startFakeV31>>;
  let h: BootedHarness;
  let botId = "";

  beforeAll(async () => {
    stub = await startFakeV31();
    h = await bootHarness({
      instances: { ghost: { driver: "not-a-real-driver", displayName: "Ghost" } },
    });
    const saved = await h.api("PUT", "/api/config", {
      composio: { apiKey: API_KEY, backendUrl: `http://127.0.0.1:${stub.port}` },
    });
    expect(saved.status).toBe(200);
    expect(JSON.stringify(saved.body)).not.toContain(API_KEY);
    botId = (await h.api("POST", "/api/bots")).body.bot.id;
  }, 30_000);

  afterAll(async () => {
    await h?.stop();
    await new Promise<void>((r) => stub.server.close(() => r()));
  });

  it("returns stale + suffixed identities for two Gmail accounts on one bot", async () => {
    const listed = await h.api("GET", `/api/connectors?services=gmail&botId=${botId}`);
    expect(listed.status).toBe(200);
    expect(listed.body.configured).toBe(true);
    expect(listed.body.services.gmail.health).toBe("stale");
    expect(listed.body.services.gmail.nextStep).toMatch(/expired/i);
    expect(listed.body.services.gmail.identity).toBe("gmail");
    const extras = listed.body.services.gmail.accounts ?? [];
    const identities = [listed.body.services.gmail.identity, ...extras.map((a: { identity: string }) => a.identity)];
    expect(identities).toEqual(expect.arrayContaining(["gmail", "gmail:acc_mail_2"]));
    expect(JSON.stringify(listed.body)).not.toContain(API_KEY);
    expect(JSON.stringify(listed.body)).not.toMatch(/Bearer |client_secret/i);
  });
});
