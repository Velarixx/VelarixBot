import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { InternalUserPrincipal } from "../auth.ts";
import { openDatabase } from "../db/database.ts";
import type { SqliteDatabase } from "../db/sqlite-native.ts";
import { IdentitySessions } from "../identity.ts";
import { createRepositories, type Repositories } from "../repositories/index.ts";
import { createBotsService, type BotsService } from "../services/bots.ts";
import type { RouteHandler } from "./context.ts";
import {
  createSaasBotCatalogRoutes,
  SAAS_BOT_CATALOG_MESSAGE_MAX,
} from "./saas-bot-catalog.ts";

const selection = () => ({ instanceId: "claude", model: "claude-sonnet-5" });

function invokeGet(
  handler: RouteHandler,
  path: string,
  principal?: InternalUserPrincipal,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any; headers: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    const req = Object.assign(new EventEmitter(), { headers }) as IncomingMessage;
    let status = 200;
    const responseHeaders: Record<string, string> = {};
    const chunks: Buffer[] = [];
    const res = {
      setHeader(name: string, value: string) {
        responseHeaders[name.toLowerCase()] = value;
      },
      writeHead(code: number, nextHeaders?: Record<string, string>) {
        status = code;
        for (const [name, value] of Object.entries(nextHeaders ?? {})) {
          responseHeaders[name.toLowerCase()] = value;
        }
      },
      end(data?: string | Buffer) {
        if (data) chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(String(data)));
        resolve({
          status,
          body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"),
          headers: responseHeaders,
        });
      },
    } as unknown as ServerResponse;
    const url = new URL(`http://127.0.0.1${path}`);
    Promise.resolve(
      handler({ req, res, url, path: url.pathname, method: "GET", ...(principal ? { principal } : {}) }),
    ).catch(reject);
  });
}

describe("SaaS bot catalog route", () => {
  let db: SqliteDatabase;
  let repos: Repositories;
  let bots: BotsService;
  let ownerA: InternalUserPrincipal;
  let ownerB: InternalUserPrincipal;

  beforeEach(() => {
    db = openDatabase(":memory:");
    repos = createRepositories(db);
    const identity = new IdentitySessions(db);
    const userA = identity.upsertGithubIdentity({ githubId: 101, login: "catalog-a" }, 1_000);
    const userB = identity.upsertGithubIdentity({ githubId: 202, login: "catalog-b" }, 1_000);
    ownerA = { kind: "internal-user", user: { id: userA.id } };
    ownerB = { kind: "internal-user", user: { id: userB.id } };
    bots = createBotsService({
      repos,
      defaultSelection: selection,
      computerBindings: () => ["workspace-machine-secret"],
    });
  });

  afterEach(() => db.close());

  it("lists only principal-owned bots and makes foreign and legacy rows absent", async () => {
    const legacy = bots.createBot();
    bots.patchBot(legacy.id, { name: "Legacy Global" });
    const botA = bots.forOwner(ownerA.user.id).createBot();
    bots.forOwner(ownerA.user.id).patchBot(botA.id, { name: "Alpha" });
    const botB = bots.forOwner(ownerB.user.id).createBot();
    bots.forOwner(ownerB.user.id).patchBot(botB.id, { name: "Beta" });

    const handler = createSaasBotCatalogRoutes({ bots });
    const a = await invokeGet(handler, "/api/bots", ownerA);
    const b = await invokeGet(handler, "/api/bots", ownerB);

    expect(a.status).toBe(200);
    expect(a.body.bots.map((bot: { name: string }) => bot.name)).toEqual(["Alpha"]);
    expect(b.body.bots.map((bot: { name: string }) => bot.name)).toEqual(["Beta"]);
    expect(JSON.stringify([a.body, b.body])).not.toMatch(/Legacy Global/);
    expect(a.headers["cache-control"]).toBe("private, no-store");
  });

  it("ignores caller identity hints, caps hydration, and never calls global catalog methods", async () => {
    const publicBots = vi.fn(() => []);
    const forOwner = vi.fn(() => ({ publicBots }));
    const globalPublicBots = vi.fn(() => {
      throw new Error("process-global catalog must not run");
    });
    const handler = createSaasBotCatalogRoutes({
      bots: { forOwner, publicBots: globalPublicBots } as unknown as Pick<BotsService, "forOwner">,
    });

    const response = await invokeGet(
      handler,
      `/api/bots?ownerId=${ownerB.user.id}&user=${ownerB.user.id}&messages=999`,
      ownerA,
      { "x-owner-id": ownerB.user.id, cookie: "owner=session-secret" },
    );

    expect(response.status).toBe(200);
    expect(forOwner).toHaveBeenCalledWith(ownerA.user.id);
    expect(publicBots).toHaveBeenCalledWith({ messages: SAAS_BOT_CATALOG_MESSAGE_MAX });
    expect(globalPublicBots).not.toHaveBeenCalled();
  });

  it.each(["-1", "1.5", "NaN", "", "999999999999999999999999", "1&messages=2"])(
    "rejects malformed or ambiguous hydration deterministically: %s",
    async (value) => {
      const handler = createSaasBotCatalogRoutes({ bots });
      const response = await invokeGet(handler, `/api/bots?messages=${value}`, ownerA);
      expect(response).toMatchObject({
        status: 400,
        body: { error: "messages must be one non-negative whole number" },
      });
    },
  );

  it("uses a field allowlist and omits internal ids, bindings, secrets, cursors, and raw errors", async () => {
    const owned = bots.forOwner(ownerA.user.id);
    const bot = owned.createBot();
    owned.patchBot(bot.id, {
      name: "Safe Catalog Name",
      title: "Public title",
      description: "Public description",
      computer: "workspace-machine-secret",
      enabledApps: ["session-cookie-token-secret"],
      stateDetail: "raw-provider-error-secret",
      threadParticipants: [ownerB.user.id],
    });
    bots.setResumeCursor(bot.id, "provider", "resume-cursor-secret");
    owned.appendMessage(bot.threadId, {
      role: "bot",
      kind: "activity",
      text: "catalog-safe-message",
      tool: { name: "token-bearing-tool-secret" },
      from: { botId: bot.id, name: "hidden-sender" },
    });

    const response = await invokeGet(createSaasBotCatalogRoutes({ bots }), "/api/bots?messages=20", ownerA);
    expect(response.status).toBe(200);
    expect(response.body.bots).toHaveLength(1);
    expect(Object.keys(response.body.bots[0]).sort()).toEqual(
      ["color", "description", "hasMore", "messages", "name", "title"].sort(),
    );
    expect(response.body.bots[0]).toMatchObject({
      name: "Safe Catalog Name",
      title: "Public title",
      description: "Public description",
    });
    expect(response.body.bots[0].messages.at(-1)).toMatchObject({ text: "catalog-safe-message" });
    expect(Object.keys(response.body.bots[0].messages.at(-1)).sort()).toEqual(
      ["at", "kind", "role", "text"].sort(),
    );

    const serialized = JSON.stringify(response.body);
    for (const secret of [
      bot.id,
      bot.threadId,
      ownerA.user.id,
      ownerB.user.id,
      "workspace-machine-secret",
      "session-cookie-token-secret",
      "raw-provider-error-secret",
      "resume-cursor-secret",
      "token-bearing-tool-secret",
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).not.toMatch(/resumeCursors|ownerId|threadId|computer|workspace|machine|cookie|token/i);
  });

  it("fails closed without a principal and converts service failures to a generic error", async () => {
    const missing = await invokeGet(createSaasBotCatalogRoutes({ bots }), "/api/bots");
    expect(missing).toMatchObject({ status: 401, body: { error: "unauthorized" } });

    const throwing = createSaasBotCatalogRoutes({
      bots: {
        forOwner() {
          throw new Error("raw database cookie token session secret");
        },
      },
    });
    const failed = await invokeGet(throwing, "/api/bots", ownerA);
    expect(failed).toMatchObject({ status: 500, body: { error: "internal server error" } });
    expect(JSON.stringify(failed.body)).not.toMatch(/database|cookie|token|session|secret/i);
  });
});
