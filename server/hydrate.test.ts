// PR-V4 pageable hydration on GET /api/bots and GET /api/events/snapshot,
// plus before-paged thread history and per-image fetch. Isolated HOME
// (vitest setup temp dir + DATA_DIR wipe). No live desktop, no sleeps.
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import { defaultDbPath, openDatabase } from "./db/database.ts";
import type { SqliteDatabase } from "./db/sqlite-native.ts";
import { parsePageSize } from "./routes/context.ts";
import { createBotsRoutes } from "./routes/bots.ts";
import { createEventsRoutes } from "./routes/events.ts";
import { createRepositories, type Repositories } from "./repositories/index.ts";
import { createBotsService, type BotsService } from "./services/bots.ts";
import { createSseHub } from "./services/events.ts";

const selection = () => ({ instanceId: "claude", model: "claude-sonnet-5" });
const CURSOR = "sess-must-not-leak";
const PNG_BYTES = Buffer.from("not-really-a-png-but-bytes-are-bytes");
const PNG_BASE64 = PNG_BYTES.toString("base64");

function invokeGet(
  handler: (ctx: {
    req: IncomingMessage;
    res: ServerResponse;
    url: URL;
    path: string;
    method: string;
  }) => Promise<boolean> | boolean,
  path: string,
): Promise<{ status: number; body: any; bytes: Buffer; contentType: string }> {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter() as IncomingMessage;
    let status = 200;
    let contentType = "";
    const chunks: Buffer[] = [];
    const res = {
      writeHead(code: number, headers?: Record<string, string | number>) {
        status = code;
        if (headers && typeof headers["content-type"] === "string") contentType = headers["content-type"];
      },
      end(data?: string | Buffer) {
        if (data) chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(String(data)));
        const bytes = Buffer.concat(chunks);
        let body: any = null;
        if (contentType.includes("json") || (!contentType && bytes.length)) {
          try {
            body = JSON.parse(bytes.toString("utf8") || "{}");
          } catch {
            body = null;
          }
        }
        resolve({ status, body, bytes, contentType });
      },
      write() {
        return true;
      },
    } as unknown as ServerResponse;
    const url = new URL(`http://127.0.0.1${path}`);
    Promise.resolve(handler({ req, res, url, path: url.pathname, method: "GET" })).catch(reject);
  });
}

describe("parsePageSize", () => {
  it("treats a missing param as full-compat and rejects junk", () => {
    expect(parsePageSize(null)).toBeUndefined();
    expect(parsePageSize("3")).toBe(3);
    expect(parsePageSize("0")).toBe(0);
    expect(parsePageSize("500")).toBe(200);
    expect(parsePageSize("-1")).toBeNull();
    expect(parsePageSize("lots")).toBeNull();
    expect(parsePageSize("1.5")).toBeNull();
  });
});

describe("pageable hydration", () => {
  let db: SqliteDatabase;
  let repos: Repositories;
  let bots: BotsService;

  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    db = openDatabase(defaultDbPath());
    repos = createRepositories(db);
    bots = createBotsService({ repos, defaultSelection: selection });
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  });

  function seedThread() {
    const bot = bots.createBot();
    bots.setResumeCursor(bot.id, "claude", CURSOR);
    bots.patchBot(bot.id, { enabledApps: ["gmail"] });
    // createBot already wrote greeting + onboarding; add enough text that
    // a page of 3 cannot be the whole transcript, plus one screen frame
    const texts: string[] = [];
    for (let i = 0; i < 8; i++) {
      texts.push(bots.appendMessage(bot.threadId, { role: "user", kind: "text", text: `probe ${i}` }).id);
    }
    const screen = bots.appendMessage(bot.threadId, {
      role: "bot",
      kind: "screen",
      png: PNG_BASE64,
      mime: "image/png",
    });
    const full = bots.messagesFor(bot.threadId);
    return { bot, texts, screen, full };
  }

  function botsHandler() {
    return createBotsRoutes({
      bots,
      turns: {} as never,
      teach: {} as never,
      routines: {} as never,
      registry: {} as never,
      computers: {} as never,
      cfg: {} as never,
      broadcast: () => {},
    });
  }

  function snapshotHandler() {
    return createEventsRoutes({ hub: createSseHub(), bots });
  }

  function assertNoCursor(value: unknown) {
    const raw = JSON.stringify(value);
    expect(raw).not.toContain(CURSOR);
    expect(raw).not.toContain("resumeCursors");
  }

  it("omitting the query is explicitly full-compat on both surfaces", async () => {
    const { full } = seedThread();
    expect(full.length).toBeGreaterThan(3);
    expect(full.at(-1)?.png).toBe(PNG_BASE64);

    for (const [handler, path] of [
      [botsHandler(), "/api/bots"],
      [snapshotHandler(), "/api/events/snapshot"],
    ] as const) {
      const { status, body } = await invokeGet(handler, path);
      expect(status).toBe(200);
      expect(body.bots).toHaveLength(1);
      expect(body.bots[0].messages).toHaveLength(full.length);
      expect(body.bots[0].messages.map((m: { id: string }) => m.id)).toEqual(full.map((m) => m.id));
      expect(body.bots[0]).not.toHaveProperty("hasMore");
      const screen = body.bots[0].messages.at(-1);
      expect(screen.png).toBe(PNG_BASE64);
      expect(screen.hasImage).toBeUndefined();
      expect(body.bots[0].enabledApps).toEqual(["gmail"]);
      assertNoCursor(body);
    }
  });

  it("?messages=n pages newest-n on both surfaces and slims screens", async () => {
    const { full } = seedThread();
    const newest = full.slice(-3);

    for (const [handler, path] of [
      [botsHandler(), "/api/bots?messages=3"],
      [snapshotHandler(), "/api/events/snapshot?messages=3"],
    ] as const) {
      const { status, body } = await invokeGet(handler, path);
      expect(status).toBe(200);
      expect(body.bots[0].messages).toHaveLength(3);
      expect(body.bots[0].messages.map((m: { id: string }) => m.id)).toEqual(newest.map((m) => m.id));
      expect(body.bots[0].hasMore).toBe(true);
      const screen = body.bots[0].messages.at(-1);
      expect(screen.kind).toBe("screen");
      expect(screen.hasImage).toBe(true);
      expect(screen.png).toBeUndefined();
      expect(JSON.stringify(body)).not.toContain(PNG_BASE64);
      expect(body.bots[0].enabledApps).toEqual(["gmail"]);
      assertNoCursor(body);
    }
  });

  it("before= walks thread history and per-image fetch returns the bytes", async () => {
    const { bot, full, screen } = seedThread();
    const handler = botsHandler();
    const fourth = full[3];

    const page = await invokeGet(handler, `/api/threads/${bot.threadId}/messages?before=${fourth.id}&limit=2`);
    expect(page.status).toBe(200);
    expect(page.body.messages.map((m: { id: string }) => m.id)).toEqual([full[1].id, full[2].id]);
    expect(page.body.hasMore).toBe(true);

    const top = await invokeGet(handler, `/api/threads/${bot.threadId}/messages?limit=200`);
    expect(top.body.hasMore).toBe(false);
    expect(top.body.messages).toHaveLength(full.length);
    const slimScreen = top.body.messages.at(-1);
    expect(slimScreen.hasImage).toBe(true);
    expect(slimScreen.png).toBeUndefined();

    const image = await invokeGet(handler, `/api/threads/${bot.threadId}/messages/${screen.id}/image`);
    expect(image.status).toBe(200);
    expect(image.contentType).toBe("image/png");
    expect(image.bytes.equals(PNG_BYTES)).toBe(true);
  });

  it("refuses a cursor or size it cannot page from", async () => {
    const { bot } = seedThread();
    const handler = botsHandler();
    expect((await invokeGet(handler, `/api/threads/${bot.threadId}/messages?before=nope`)).status).toBe(404);
    expect((await invokeGet(handler, "/api/threads/not-a-thread/messages")).status).toBe(404);
    expect((await invokeGet(handler, "/api/bots?messages=-1")).status).toBe(400);
    expect((await invokeGet(handler, "/api/bots?messages=lots")).status).toBe(400);
    expect((await invokeGet(snapshotHandler(), "/api/events/snapshot?messages=1.5")).status).toBe(400);
    expect((await invokeGet(handler, `/api/threads/${bot.threadId}/messages?limit=1.5`)).status).toBe(400);
  });

  it("404s an image on a message or conversation that has none, without inventing a thread", async () => {
    const { bot, full } = seedThread();
    const handler = botsHandler();
    const none = await invokeGet(handler, `/api/threads/${bot.threadId}/messages/${full[0].id}/image`);
    expect(none.status).toBe(404);
    expect(none.body.error).toBe("no image on that message");

    const before = bots.count();
    const missing = await invokeGet(handler, "/api/threads/not-a-thread/messages/not-a-message/image");
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe("no such conversation");
    expect((await invokeGet(handler, "/api/threads/not-a-thread/messages")).status).toBe(404);
    expect(bots.count()).toBe(before);
  });
});
