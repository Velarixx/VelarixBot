// publicBot allowlist on the three wire surfaces: GET /api/bots,
// GET /api/events/snapshot, and every {kind:"bot"} SSE frame.
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import { defaultDbPath, openDatabase } from "./db/database.ts";
import type { SqliteDatabase } from "./db/sqlite-native.ts";
import { createRepositories, type Repositories } from "./repositories/index.ts";
import { createBotsRoutes } from "./routes/bots.ts";
import { createEventsRoutes } from "./routes/events.ts";
import { createBotsService, projectPublicBotFrame, type BotsService } from "./services/bots.ts";
import { createSseHub } from "./services/events.ts";

const selection = () => ({ instanceId: "claude", model: "claude-sonnet-5" });
const CURSOR = "sess-must-not-leak";

function invokeGet(
  handler: (ctx: {
    req: IncomingMessage;
    res: ServerResponse;
    url: URL;
    path: string;
    method: string;
  }) => Promise<boolean> | boolean,
  path: string,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter() as IncomingMessage;
    let status = 200;
    const chunks: Buffer[] = [];
    const res = {
      writeHead(code: number) {
        status = code;
      },
      end(data?: string | Buffer) {
        if (data) chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(String(data)));
        resolve({ status, body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") });
      },
      write() {
        return true;
      },
    } as unknown as ServerResponse;
    const url = new URL(`http://127.0.0.1${path}`);
    Promise.resolve(handler({ req, res, url, path: url.pathname, method: "GET" })).catch(reject);
  });
}

function assertNoCursor(value: unknown) {
  const raw = JSON.stringify(value);
  expect(raw).not.toContain(CURSOR);
  expect(raw).not.toContain("resumeCursors");
}

describe("publicBot wire surfaces", () => {
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

  function seeded() {
    const bot = bots.createBot();
    bots.setResumeCursor(bot.id, "claude", CURSOR);
    bots.patchBot(bot.id, { enabledApps: ["gmail"] });
    expect(bots.bot(bot.id)?.resumeCursors).toEqual({ claude: CURSOR });
    return bot;
  }

  it("GET /api/bots omits resumeCursors and keeps enabledApps", async () => {
    seeded();
    const handler = createBotsRoutes({
      bots,
      turns: {} as never,
      teach: {} as never,
      routines: {} as never,
      registry: {} as never,
      computers: {} as never,
      cfg: {} as never,
      broadcast: () => {},
    });
    const { status, body } = await invokeGet(handler, "/api/bots");
    expect(status).toBe(200);
    expect(body.bots).toHaveLength(1);
    expect(body.bots[0].enabledApps).toEqual(["gmail"]);
    assertNoCursor(body);
  });

  it("GET /api/events/snapshot omits resumeCursors", async () => {
    seeded();
    const hub = createSseHub();
    const handler = createEventsRoutes({ hub, bots });
    const { status, body } = await invokeGet(handler, "/api/events/snapshot");
    expect(status).toBe(200);
    expect(body.bots).toHaveLength(1);
    expect(body.bots[0].enabledApps).toEqual(["gmail"]);
    assertNoCursor(body);
  });

  it("every {kind:\"bot\"} SSE payload is projected through the allowlist", () => {
    const bot = seeded();
    const leaked = { kind: "bot", bot: bots.bot(bot.id) };
    expect(JSON.stringify(leaked)).toContain(CURSOR);
    const projected = projectPublicBotFrame(leaked, (id) => bots.publicBot(id));
    assertNoCursor(projected);
    expect((projected as { bot: { enabledApps?: string[] } }).bot.enabledApps).toEqual(["gmail"]);
  });
});
