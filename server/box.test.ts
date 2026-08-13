import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import type { AppConfig } from "./config.ts";
import { boxNameForBot, findBox, readBoxPath, WORKSPACE_BOX_NAME } from "./box.ts";

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
    expect(boxNameForBot("bot-a")).toBe(`${WORKSPACE_BOX_NAME}-bot-a`);
    expect(boxNameForBot("bot-b")).not.toBe(boxNameForBot("bot-a"));
  });

  it("findBox respects botId across two fake workspaces", async () => {
    const fake = await startFakeBoxes([
      { id: "box-a", name: boxNameForBot("bot-a"), state: "idle" },
      { id: "box-b", name: boxNameForBot("bot-b"), state: "running" },
      { id: "shared", name: WORKSPACE_BOX_NAME, state: "idle" },
    ]);
    server = fake.server;
    const a = await findBox(fake.cfg, "bot-a");
    const b = await findBox(fake.cfg, "bot-b");
    expect(a).toMatchObject({ id: "box-a", name: boxNameForBot("bot-a") });
    expect(b).toMatchObject({ id: "box-b", name: boxNameForBot("bot-b") });
    expect(a?.id).not.toBe(b?.id);
    expect(await findBox(fake.cfg, "bot-missing")).toBeNull();
  });

  it("readBoxPath refuses relative paths and .. before contacting the box", async () => {
    const cfg = { box: { token: "tok_test", url: "http://127.0.0.1:9" } };
    await expect(readBoxPath(cfg, "bot-a", "relative.txt")).rejects.toThrow(/absolute/);
    await expect(readBoxPath(cfg, "bot-a", "/tmp/../etc/passwd")).rejects.toThrow(/absolute/);
  });
});
