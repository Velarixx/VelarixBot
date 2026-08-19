import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { InternalUserPrincipal } from "../auth.ts";
import { openDatabase } from "../db/database.ts";
import type { SqliteDatabase } from "../db/sqlite-native.ts";
import { IdentitySessions } from "../identity.ts";
import { PUBLIC_BOT_HANDLE_LENGTH, PUBLIC_BOT_HANDLE_PATTERN } from "../public-bot-handle.ts";
import { createBotsRepository } from "../repositories/bots.ts";
import { createRepositories, type Repositories } from "../repositories/index.ts";
import { createBotsService, type BotsService } from "../services/bots.ts";
import type { RouteHandler } from "./context.ts";
import {
  createSaasBotCatalogRoutes,
  SAAS_BOT_CREATE_BODY_MAX_BYTES,
  SAAS_BOT_CATALOG_MESSAGE_MAX,
  SAAS_BOT_OWNER_QUOTA,
} from "./saas-bot-catalog.ts";

const selection = () => ({ instanceId: "claude", model: "claude-sonnet-5" });

function invokeRoute(
  handler: RouteHandler,
  path: string,
  principal?: InternalUserPrincipal,
  headers: Record<string, string> = {},
  method = "GET",
  rawBody?: string,
): Promise<{ status: number; body: any; headers: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    const req = Object.assign(
      Readable.from(rawBody === undefined ? [] : [Buffer.from(rawBody)]),
      { headers },
    ) as IncomingMessage;
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
      handler({ req, res, url, path: url.pathname, method, ...(principal ? { principal } : {}) }),
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
    const a = await invokeRoute(handler, "/api/bots", ownerA);
    const b = await invokeRoute(handler, "/api/bots", ownerB);

    expect(a.status).toBe(200);
    expect(a.body.bots.map((bot: { name: string }) => bot.name)).toEqual(["Alpha"]);
    expect(b.body.bots.map((bot: { name: string }) => bot.name)).toEqual(["Beta"]);
    expect(a.body.bots[0].publicHandle).toBe(botA.publicHandle);
    expect(b.body.bots[0].publicHandle).toBe(botB.publicHandle);
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

    const response = await invokeRoute(
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
      const response = await invokeRoute(handler, `/api/bots?messages=${value}`, ownerA);
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

    const response = await invokeRoute(createSaasBotCatalogRoutes({ bots }), "/api/bots?messages=20", ownerA);
    expect(response.status).toBe(200);
    expect(response.body.bots).toHaveLength(1);
    expect(Object.keys(response.body.bots[0]).sort()).toEqual(
      ["color", "description", "hasMore", "messages", "name", "publicHandle", "title"].sort(),
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

  it("creates one principal-owned default bot and returns only the catalog projection", async () => {
    const legacy = bots.createBot();
    const foreign = bots.forOwner(ownerB.user.id).createBot();
    const response = await invokeRoute(
      createSaasBotCatalogRoutes({ bots }),
      `/api/bots?ownerId=${ownerB.user.id}&botId=${foreign.id}`,
      ownerA,
      { "x-owner-id": ownerB.user.id, "content-type": "application/json" },
      "POST",
      "{}",
    );

    expect(response.status).toBe(201);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(Object.keys(response.body)).toEqual(["bot"]);
    expect(Object.keys(response.body.bot).sort()).toEqual(
      ["color", "description", "hasMore", "messages", "name", "publicHandle", "title"].sort(),
    );
    expect(response.body.bot).toMatchObject({
      publicHandle: expect.stringMatching(PUBLIC_BOT_HANDLE_PATTERN),
      name: "New Bot",
      title: "",
      description: "",
      hasMore: false,
      messages: [
        { role: "bot", kind: "text" },
        { role: "bot", kind: "options" },
      ],
    });

    const created = bots.forOwner(ownerA.user.id).bots();
    expect(created).toHaveLength(1);
    expect(bots.forOwner(ownerA.user.id).messagesFor(created[0].threadId)).toHaveLength(2);
    expect(bots.forOwner(ownerB.user.id).messagesFor(created[0].threadId)).toEqual([]);
    expect(
      db.prepare<{ owner_id: string | null }>("SELECT owner_id FROM threads WHERE id = ?").get(created[0].threadId),
    ).toEqual({ owner_id: ownerA.user.id });

    const serialized = JSON.stringify(response.body);
    for (const internal of [created[0].id, created[0].threadId, legacy.id, foreign.id, ownerA.user.id, ownerB.user.id]) {
      expect(serialized).not.toContain(internal);
    }
    expect(serialized).not.toMatch(/modelSelection|computer|provider|approval|usage|cursor|token|secret/i);
  });

  it.each([
    ["empty", ""],
    ["malformed", "{"],
    ["array", "[]"],
    ["null", "null"],
    ["scalar", "true"],
    ["non-exact whitespace", "{ }"],
    ["semantic field", '{"name":"caller-controlled"}'],
    ["caller-supplied handle", '{"publicHandle":"caller-controlled"}'],
    ["oversized", " ".repeat(SAAS_BOT_CREATE_BODY_MAX_BYTES + 1)],
  ])("rejects %s create payloads generically without writes", async (_label, rawBody) => {
    const before = db.prepare<{ n: number }>("SELECT count(*) AS n FROM messages").get()?.n;
    const response = await invokeRoute(
      createSaasBotCatalogRoutes({ bots }),
      "/api/bots",
      ownerA,
      { "content-type": "application/json" },
      "POST",
      rawBody,
    );
    expect(response).toMatchObject({ status: 400, body: { error: "invalid request" } });
    expect(bots.forOwner(ownerA.user.id).count()).toBe(0);
    expect(db.prepare<{ n: number }>("SELECT count(*) AS n FROM messages").get()?.n).toBe(before);
  });

  it("counts only the principal's bots and returns a stable no-write quota conflict", async () => {
    bots.createBot();
    bots.createBot();
    bots.forOwner(ownerB.user.id).createBot();
    for (let index = 1; index < SAAS_BOT_OWNER_QUOTA; index++) {
      bots.forOwner(ownerA.user.id).createBot();
    }

    const handler = createSaasBotCatalogRoutes({ bots });
    const success = await invokeRoute(handler, "/api/bots", ownerA, {}, "POST", "{}");
    expect(success.status).toBe(201);
    expect(bots.forOwner(ownerA.user.id).count()).toBe(SAAS_BOT_OWNER_QUOTA);
    const beforeMessages = db.prepare<{ n: number }>("SELECT count(*) AS n FROM messages").get()?.n;

    const conflict = await invokeRoute(handler, "/api/bots", ownerA, {}, "POST", "{}");
    expect(conflict).toMatchObject({ status: 409, body: { error: "bot quota reached" } });
    expect(bots.forOwner(ownerA.user.id).count()).toBe(SAAS_BOT_OWNER_QUOTA);
    expect(db.prepare<{ n: number }>("SELECT count(*) AS n FROM messages").get()?.n).toBe(beforeMessages);
  });

  it("fails closed without a principal and converts service failures to a generic error", async () => {
    const missing = await invokeRoute(createSaasBotCatalogRoutes({ bots }), "/api/bots");
    expect(missing).toMatchObject({ status: 401, body: { error: "unauthorized" } });

    const throwing = createSaasBotCatalogRoutes({
      bots: {
        forOwner() {
          throw new Error("raw database cookie token session secret");
        },
      },
    });
    const failed = await invokeRoute(throwing, "/api/bots", ownerA);
    expect(failed).toMatchObject({ status: 500, body: { error: "internal server error" } });
    expect(JSON.stringify(failed.body)).not.toMatch(/database|cookie|token|session|secret/i);

    const writeFailure = await invokeRoute(
      createSaasBotCatalogRoutes({
        bots: {
          forOwner() {
            throw new Error("raw provider workspace database secret");
          },
        },
      }),
      "/api/bots",
      ownerA,
      {},
      "POST",
      "{}",
    );
    expect(writeFailure).toMatchObject({ status: 500, body: { error: "internal server error" } });
    expect(JSON.stringify(writeFailure.body)).not.toMatch(/provider|workspace|database|secret/i);
  });

  it("converts a retained-handle collision to a generic error with no partial writes", async () => {
    const fixedHandle = "D".repeat(PUBLIC_BOT_HANDLE_LENGTH);
    const collisionRepos: Repositories = {
      ...repos,
      bots: createBotsRepository(db, { generatePublicHandle: () => fixedHandle }),
    };
    const collisionBots = createBotsService({ repos: collisionRepos, defaultSelection: selection });
    const first = collisionBots.forOwner(ownerA.user.id).createBot();
    expect(collisionBots.forOwner(ownerA.user.id).deleteBot(first.id)).toBe(true);
    const before = {
      bots: db.prepare<{ n: number }>("SELECT count(*) AS n FROM bots").get()!.n,
      threads: db.prepare<{ n: number }>("SELECT count(*) AS n FROM threads").get()!.n,
      messages: db.prepare<{ n: number }>("SELECT count(*) AS n FROM messages").get()!.n,
    };

    const response = await invokeRoute(
      createSaasBotCatalogRoutes({ bots: collisionBots }),
      "/api/bots",
      ownerA,
      {},
      "POST",
      "{}",
    );
    expect(response).toMatchObject({ status: 500, body: { error: "internal server error" } });
    expect(JSON.stringify(response.body)).not.toMatch(/unique|constraint|handle|database/i);
    expect(db.prepare<{ n: number }>("SELECT count(*) AS n FROM bots").get()!.n).toBe(before.bots);
    expect(db.prepare<{ n: number }>("SELECT count(*) AS n FROM threads").get()!.n).toBe(before.threads);
    expect(db.prepare<{ n: number }>("SELECT count(*) AS n FROM messages").get()!.n).toBe(before.messages);
  });
});
