import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import type { AppConfig } from "./config.ts";
import {
  boxNameForBot,
  botBoxCwd,
  decodeBoxSharing,
  DEFAULT_LEASE_WAIT_MS,
  findBox,
  listStaleBotBoxes,
  provisionBox,
  readBoxPath,
  sharedBoxName,
  wrapCommandInCwd,
  WORKSPACE_BOX_NAME,
} from "./box.ts";

const NONE: AppConfig = {};

function startFakeBoxes(boxes: Array<{ id: string; name: string; state?: string }>): Promise<{ server: Server; cfg: AppConfig }> {
  const server = createServer((req, res) => {
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.url === "/boxes" && req.method === "GET") return json(200, { ok: true, boxes });
    json(404, { error: "nope" });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        server,
        cfg: { box: { token: "tok_test", url: `http://127.0.0.1:${port}` } },
      });
    });
  });
}

describe("per-bot Box workspaces", () => {
  let server: Server;
  afterEach(async () => {
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("names a workspace from the bot id", () => {
    expect(boxNameForBot(NONE, "bot-a")).toBe(`${WORKSPACE_BOX_NAME}-bot-a`);
    expect(boxNameForBot(NONE, "bot-b")).not.toBe(boxNameForBot(NONE, "bot-a"));
  });

  it("default knobs (shared off, empty prefix) leave today's names untouched", () => {
    expect(boxNameForBot({ box: { token: "t" } }, "bot-a")).toBe("velarixbot-workspace-bot-a");
    expect(boxNameForBot({ box: { shared: false, namePrefix: "" } }, "bot-a")).toBe("velarixbot-workspace-bot-a");
  });

  it("findBox respects botId across two fake workspaces", async () => {
    const fake = await startFakeBoxes([
      { id: "box-a", name: boxNameForBot(NONE, "bot-a"), state: "idle" },
      { id: "box-b", name: boxNameForBot(NONE, "bot-b"), state: "running" },
      { id: "shared", name: WORKSPACE_BOX_NAME, state: "idle" },
    ]);
    server = fake.server;
    const a = await findBox(fake.cfg, "bot-a");
    const b = await findBox(fake.cfg, "bot-b");
    expect(a).toMatchObject({ id: "box-a", name: boxNameForBot(NONE, "bot-a") });
    expect(b).toMatchObject({ id: "box-b", name: boxNameForBot(NONE, "bot-b") });
    expect(a?.id).not.toBe(b?.id);
    expect(await findBox(fake.cfg, "bot-missing")).toBeNull();
  });

  it("readBoxPath refuses relative paths and .. before contacting the box", async () => {
    const cfg = { box: { token: "tok_test", url: "http://127.0.0.1:9" } };
    await expect(readBoxPath(cfg, "bot-a", "relative.txt")).rejects.toThrow(/absolute/);
    await expect(readBoxPath(cfg, "bot-a", "/tmp/../etc/passwd")).rejects.toThrow(/absolute/);
  });
});

describe("shared-box naming (3.2.4 + D4)", () => {
  let server: Server;
  afterEach(async () => {
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("shared=true collapses every bot onto the exact shared name", () => {
    const cfg: AppConfig = { box: { shared: true } };
    expect(boxNameForBot(cfg, "bot-a")).toBe("velarixbot-workspace");
    expect(boxNameForBot(cfg, "bot-b")).toBe(boxNameForBot(cfg, "bot-a"));
    expect(sharedBoxName(cfg)).toBe("velarixbot-workspace");
  });

  it("namePrefix applies to BOTH the shared and the per-bot names, sanitized like botIds", () => {
    expect(boxNameForBot({ box: { shared: true, namePrefix: "dyon-" } }, "bot-a")).toBe("dyon-velarixbot-workspace");
    expect(boxNameForBot({ box: { namePrefix: "dyon-" } }, "bot-a")).toBe("dyon-velarixbot-workspace-bot-a");
    // sanitizer: same character class as bot ids — junk is stripped
    expect(boxNameForBot({ box: { namePrefix: "dy on/$-" } }, "bot-a")).toBe("dyon-velarixbot-workspace-bot-a");
  });

  it("strict decode: non-boolean shared / non-string prefix / bad leaseWaitMs are config errors", () => {
    expect(() => decodeBoxSharing({ box: { shared: "yes" as unknown as boolean } })).toThrow(/box\.shared/);
    expect(() => decodeBoxSharing({ box: { namePrefix: 7 as unknown as string } })).toThrow(/box\.namePrefix/);
    expect(() => decodeBoxSharing({ box: { leaseWaitMs: -1 } })).toThrow(/box\.leaseWaitMs/);
    expect(() => decodeBoxSharing({ box: { leaseWaitMs: Number.NaN } })).toThrow(/box\.leaseWaitMs/);
    expect(decodeBoxSharing({ box: { shared: true, namePrefix: "p-", leaseWaitMs: 5 } })).toEqual({
      shared: true,
      namePrefix: "p-",
      leaseWaitMs: 5,
    });
    expect(decodeBoxSharing(NONE)).toEqual({ shared: false, namePrefix: "", leaseWaitMs: DEFAULT_LEASE_WAIT_MS });
  });

  it("findBox exact-matches the prefixed shared name and reuses a stale (archived) one", async () => {
    const cfg = { box: { shared: true, namePrefix: "dyon-" } };
    const fake = await startFakeBoxes([
      { id: "other-install", name: "velarixbot-workspace", state: "idle" },
      { id: "old-per-bot", name: "dyon-velarixbot-workspace-bot-a", state: "idle" },
      { id: "ours", name: "dyon-velarixbot-workspace", state: "archived" },
    ]);
    server = fake.server;
    const merged: AppConfig = { box: { ...fake.cfg.box, ...cfg.box } };
    const found = await findBox(merged, "bot-a");
    expect(found).toMatchObject({ id: "ours", state: "archived" });
  });

  it("cleanup listing is prefix-scoped and never names the shared box or another install", async () => {
    const fake = await startFakeBoxes([
      { id: "s", name: "dyon-velarixbot-workspace", state: "idle" }, // the shared box itself
      { id: "a", name: "dyon-velarixbot-workspace-bot-a", state: "archived" },
      { id: "b", name: "dyon-velarixbot-workspace-bot-b", state: "idle" },
      { id: "x", name: "velarixbot-workspace-bot-a", state: "idle" }, // unprefixed install
      { id: "y", name: "mila-velarixbot-workspace-bot-a", state: "idle" }, // another prefix
      { id: "z", name: "unrelated", state: "idle" },
    ]);
    server = fake.server;
    const cfg: AppConfig = { box: { ...fake.cfg.box, shared: true, namePrefix: "dyon-" } };
    const stale = await listStaleBotBoxes(cfg);
    expect(stale.map((b) => b.id).sort()).toEqual(["a", "b"]);

    // an UNPREFIXED install only ever sees its own unprefixed per-bot boxes
    const bare: AppConfig = { box: { ...fake.cfg.box, shared: true } };
    expect((await listStaleBotBoxes(bare)).map((b) => b.id)).toEqual(["x"]);
  });
});

describe("provisionBox rollback (L5)", () => {
  let server: Server;
  afterEach(async () => {
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function startProvisionFake(opts: {
    existing?: Array<{ id: string; name: string; state?: string }>;
    createId?: string;
    getState?: string;
    patchOk?: boolean;
  }): Promise<{ server: Server; cfg: AppConfig; deleted: string[]; created: number; patched: number }> {
    const existing = [...(opts.existing ?? [])];
    const deleted: string[] = [];
    let created = 0;
    let patched = 0;
    const createId = opts.createId ?? "box-new";
    const getState = opts.getState ?? "error";
    const patchOk = opts.patchOk !== false;
    const server = createServer((req, res) => {
      const json = (code: number, body: unknown) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      const url = (req.url ?? "").split("?")[0] ?? "";
      if (url === "/boxes" && req.method === "GET") return json(200, { ok: true, boxes: existing });
      if (url === "/boxes" && req.method === "POST") {
        created += 1;
        const box = { id: createId, name: "", state: "creating" };
        existing.push(box);
        return json(200, { ok: true, box });
      }
      const idMatch = url.match(/^\/boxes\/([^/]+)$/);
      if (idMatch && req.method === "PATCH") {
        patched += 1;
        if (!patchOk) return json(400, { ok: false, error: "rename refused" });
        const box = existing.find((b) => b.id === idMatch[1]);
        if (box) box.name = "named";
        return json(200, { ok: true, box });
      }
      if (idMatch && req.method === "GET") {
        return json(200, { ok: true, box: { id: idMatch[1], state: getState } });
      }
      if (idMatch && req.method === "DELETE") {
        deleted.push(idMatch[1]);
        return json(200, { ok: true });
      }
      json(404, { error: "nope" });
    });
    return new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        resolve({
          server,
          cfg: { box: { token: "tok_test", url: `http://127.0.0.1:${port}` } },
          deleted,
          created,
          patched,
        });
      });
    });
  }

  it("create-ok then ready-fail DELETEs the new per-bot box", async () => {
    const fake = await startProvisionFake({ getState: "error" });
    server = fake.server;
    await expect(provisionBox(fake.cfg, "bot-a", "Ada")).rejects.toThrow(/did not become ready/);
    expect(fake.deleted).toEqual(["box-new"]);
  });

  it("shared-mode create then ready-fail does not DELETE the shared named box", async () => {
    const fake = await startProvisionFake({ getState: "error" });
    server = fake.server;
    const cfg: AppConfig = { box: { ...fake.cfg.box, shared: true } };
    await expect(provisionBox(cfg, "bot-a", "Ada")).rejects.toThrow(/did not become ready/);
    expect(fake.deleted).toEqual([]);
  });

  it("PATCH-name failure after create DELETEs the per-bot box", async () => {
    const fake = await startProvisionFake({ patchOk: false });
    server = fake.server;
    await expect(provisionBox(fake.cfg, "bot-a", "Ada")).rejects.toThrow(/box rename failed/);
    expect(fake.deleted).toEqual(["box-new"]);
  });

  it("reuse of an existing box then ready-fail does not DELETE", async () => {
    const name = boxNameForBot({ box: { token: "t" } }, "bot-a");
    const fake = await startProvisionFake({
      existing: [{ id: "box-old", name, state: "idle" }],
      getState: "error",
    });
    server = fake.server;
    await expect(provisionBox(fake.cfg, "bot-a", "Ada")).rejects.toThrow(/did not become ready/);
    expect(fake.deleted).toEqual([]);
  });
});

describe("shared-box per-bot cwd wrap", () => {
  it("botBoxCwd mirrors the local workspaces layout with the same sanitizer", () => {
    expect(botBoxCwd("bot-a")).toBe("~/workspaces/bot-a");
    expect(botBoxCwd("we ird/../id")).toBe("~/workspaces/weirdid");
    expect(botBoxCwd("")).toBe("~/workspaces/bot");
  });

  it("wrapCommandInCwd keeps multi-line commands intact via a brace group", () => {
    const wrapped = wrapCommandInCwd("~/workspaces/bot-a", "echo one\necho two # comment");
    expect(wrapped).toBe("mkdir -p ~/workspaces/bot-a && cd ~/workspaces/bot-a && {\necho one\necho two # comment\n}");
  });
});
