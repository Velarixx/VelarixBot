// First-class Conversations sections. Isolated HOME. No sleeps — wait on
// HTTP responses and bot frames. Title stays a personality field.
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import { defaultDbPath, openDatabase } from "./db/database.ts";
import type { SqliteDatabase } from "./db/sqlite-native.ts";
import { createRepositories, type Repositories } from "./repositories/index.ts";
import { createBotsRoutes } from "./routes/bots.ts";
import { createSidebarSectionsRoutes } from "./routes/sidebar-sections.ts";
import { createBotsService, type BotsService } from "./services/bots.ts";
import {
  createSidebarSection,
  deleteSidebarSection,
  listCollapsedSectionKeys,
  listSidebarSections,
  readSidebarSections,
  renameSidebarSection,
  SIDEBAR_SECTIONS_FILE,
  writeCollapsedSectionKeys,
} from "./sidebar-sections.ts";

const posixOnly = process.platform === "win32" ? it.skip : it;
const selection = () => ({ instanceId: "claude", model: "claude-sonnet-5" });

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{
  base: string;
  close: () => Promise<void>;
}> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

async function jsonFetch(base: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

describe("sidebar sections store", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("creates, renames, and deletes a named section without touching Title", () => {
    const created = createSidebarSection("  Work  ");
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.section.name).toBe("Work");
    expect(listSidebarSections()).toEqual([created.section]);

    expect(createSidebarSection("").ok).toBe(false);
    expect(createSidebarSection("   ").ok).toBe(false);
    expect(createSidebarSection("work").ok).toBe(false);
    expect(createSidebarSection("Unassigned").ok).toBe(false);

    const renamed = renameSidebarSection(created.section.id, "Ops");
    expect(renamed.ok).toBe(true);
    if (!renamed.ok) return;
    expect(renamed.section).toEqual({ id: created.section.id, name: "Ops" });
    expect(listSidebarSections()).toEqual([renamed.section]);

    const removed = deleteSidebarSection(created.section.id);
    expect(removed.ok).toBe(true);
    expect(listSidebarSections()).toEqual([]);
  });

  it("keeps an empty user section listed and persists collapse across a reread", () => {
    const empty = createSidebarSection("Empty");
    expect(empty.ok).toBe(true);
    if (!empty.ok) return;
    expect(listSidebarSections().map((s) => s.name)).toEqual(["Empty"]);
    const written = writeCollapsedSectionKeys([empty.section.id, ""]);
    expect(written.ok).toBe(true);
    expect(listCollapsedSectionKeys()).toEqual([empty.section.id, ""]);
    expect(readSidebarSections()).toEqual({
      sections: [empty.section],
      collapsed: [empty.section.id, ""],
    });
  });

  posixOnly("writes sidebar-sections.json 0600 under the private data dir", () => {
    createSidebarSection("Work");
    const path = join(DATA_DIR, SIDEBAR_SECTIONS_FILE);
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf8")).sections[0].name).toBe("Work");
  });
});

describe("sidebar sections API + bot membership", () => {
  let db: SqliteDatabase;
  let repos: Repositories;
  let bots: BotsService;
  let frames: any[];

  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    db = openDatabase(defaultDbPath());
    repos = createRepositories(db);
    bots = createBotsService({ repos, defaultSelection: selection });
    frames = [];
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  });

  function routes() {
    const broadcast = (payload: unknown) => {
      frames.push(payload);
    };
    const sections = createSidebarSectionsRoutes({ bots, broadcast });
    const botRoutes = createBotsRoutes({
      bots,
      turns: {} as never,
      teach: {} as never,
      routines: {} as never,
      registry: {} as never,
      computers: {} as never,
      cfg: {} as never,
      broadcast,
    });
    return async (ctx: {
      req: IncomingMessage;
      res: ServerResponse;
      url: URL;
      path: string;
      method: string;
    }) => (await sections(ctx)) || (await botRoutes(ctx));
  }

  it("create/rename/delete a section and return members to Unassigned without deleting bots", async () => {
    const alpha = bots.createBot();
    bots.patchBot(alpha.id, { name: "Alpha", title: "Writer" });
    const { base, close } = await listen((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      void routes()({ req, res, url, path: url.pathname, method: req.method ?? "GET" });
    });
    try {
      const created = await jsonFetch(base, "POST", "/api/sidebar-sections", { name: "Work" });
      expect(created.status).toBe(201);
      const sectionId = created.body.section.id as string;

      const moved = await jsonFetch(base, "PATCH", `/api/bots/${alpha.id}`, { sectionId });
      expect(moved.status).toBe(200);
      expect(moved.body.bot.sectionId).toBe(sectionId);
      expect(moved.body.bot.title).toBe("Writer");

      const renamed = await jsonFetch(base, "PATCH", `/api/sidebar-sections/${sectionId}`, { name: "Ops" });
      expect(renamed.status).toBe(200);
      expect(renamed.body.section.name).toBe("Ops");
      expect(bots.bot(alpha.id)?.sectionId).toBe(sectionId);
      expect(bots.bot(alpha.id)?.title).toBe("Writer");

      const deleted = await jsonFetch(base, "DELETE", `/api/sidebar-sections/${sectionId}`);
      expect(deleted.status).toBe(200);
      expect(deleted.body.sections).toEqual([]);
      expect(bots.bot(alpha.id)).toMatchObject({ id: alpha.id, title: "Writer" });
      expect(bots.bot(alpha.id)?.sectionId).toBeUndefined();
      expect(bots.publicBot(alpha.id)?.sectionId).toBeNull();
      const unassignFrame = frames.find((f) => f.kind === "bot" && f.bot?.id === alpha.id && f.bot.sectionId == null);
      expect(unassignFrame).toBeTruthy();
    } finally {
      await close();
    }
  });

  it("Move to A then B then Unassigned keeps a single sectionId; New section creates and assigns", async () => {
    const alpha = bots.createBot();
    const { base, close } = await listen((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      void routes()({ req, res, url, path: url.pathname, method: req.method ?? "GET" });
    });
    try {
      const a = await jsonFetch(base, "POST", "/api/sidebar-sections", { name: "A" });
      const b = await jsonFetch(base, "POST", "/api/sidebar-sections", { name: "B" });

      const patch = (sectionId: string | null) => jsonFetch(base, "PATCH", `/api/bots/${alpha.id}`, { sectionId });

      expect((await patch(a.body.section.id)).body.bot.sectionId).toBe(a.body.section.id);
      const afterB = await patch(b.body.section.id);
      expect(afterB.body.bot.sectionId).toBe(b.body.section.id);
      expect(afterB.body.bot.sectionId).not.toBe(a.body.section.id);
      expect((await patch(null)).body.bot.sectionId).toBeNull();

      const created = await jsonFetch(base, "POST", "/api/sidebar-sections", { name: "C" });
      const assigned = await patch(created.body.section.id);
      expect(assigned.body.bot.sectionId).toBe(created.body.section.id);
      expect(listSidebarSections().map((s) => s.name)).toEqual(["A", "B", "C"]);
    } finally {
      await close();
    }
  });

  it("Title PATCH does not move a bot and new bots land Unassigned", async () => {
    const alpha = bots.createBot();
    expect(bots.publicBot(alpha.id)?.sectionId).toBeNull();
    const created = createSidebarSection("Work");
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    bots.patchBot(alpha.id, { sectionId: created.section.id });
    const { base, close } = await listen((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      void routes()({ req, res, url, path: url.pathname, method: req.method ?? "GET" });
    });
    try {
      const patched = await jsonFetch(base, "PATCH", `/api/bots/${alpha.id}`, { title: "Chief of Staff" });
      expect(patched.status).toBe(200);
      expect(patched.body.bot.title).toBe("Chief of Staff");
      expect(patched.body.bot.sectionId).toBe(created.section.id);
      expect(bots.bot(alpha.id)?.sectionId).toBe(created.section.id);

      const fresh = bots.createBot();
      expect(fresh.sectionId).toBeUndefined();
      expect(fresh.title).toBe("");
    } finally {
      await close();
    }
  });

  it("rejects an unknown sectionId and leaves Title alone", async () => {
    const alpha = bots.createBot();
    bots.patchBot(alpha.id, { title: "Writer" });
    const { base, close } = await listen((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      void routes()({ req, res, url, path: url.pathname, method: req.method ?? "GET" });
    });
    try {
      const res = await jsonFetch(base, "PATCH", `/api/bots/${alpha.id}`, { sectionId: "missing" });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/unknown sidebar section/i);
      expect(bots.bot(alpha.id)?.title).toBe("Writer");
      expect(bots.bot(alpha.id)?.sectionId).toBeUndefined();
    } finally {
      await close();
    }
  });
});

describe("sidebar sections restart rehydrate", () => {
  it("restores sections, membership, and collapse from the same HOME", () => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    const dbPath = defaultDbPath();
    const first = openDatabase(dbPath);
    const firstBots = createBotsService({ repos: createRepositories(first), defaultSelection: selection });
    const alpha = firstBots.createBot();
    firstBots.patchBot(alpha.id, { name: "Alpha", title: "Writer" });
    const created = createSidebarSection("Work");
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    firstBots.patchBot(alpha.id, { sectionId: created.section.id });
    writeCollapsedSectionKeys([created.section.id]);
    const alphaId = alpha.id;
    first.close();

    const second = openDatabase(dbPath);
    const secondBots = createBotsService({ repos: createRepositories(second), defaultSelection: selection });
    try {
      const snapshot = readSidebarSections();
      expect(snapshot.sections).toEqual([created.section]);
      expect(snapshot.collapsed).toEqual([created.section.id]);
      expect(secondBots.bot(alphaId)?.sectionId).toBe(created.section.id);
      expect(secondBots.bot(alphaId)?.title).toBe("Writer");
      expect(secondBots.publicBot(alphaId)?.sectionId).toBe(created.section.id);
    } finally {
      second.close();
    }
  });
});
