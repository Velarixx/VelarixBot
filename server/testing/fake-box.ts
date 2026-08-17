// In-process fake of the Box vendor REST surface — just enough of the
// endpoints server/box.ts actually calls for the box ComputerProvider to
// pass conformance without a network: list/create/get/patch boxes, the
// synchronous run-command endpoint, the files read-back, desktop URL
// minting, and stop/resume. Boxes are born ready ("idle") so no test ever
// waits on a poll loop.
import { createServer, type Server } from "node:http";

export interface FakeBoxRecord {
  id: string;
  name: string | null;
  state: string;
  /** Every shell command POSTed to this box, in order (cwd-wrap asserts). */
  commands: string[];
}

export interface FakeBoxVendor {
  base: string;
  boxes: Map<string, FakeBoxRecord>;
  close(): Promise<void>;
}

function commandOutput(command: string): string {
  // the box client greps stdout for these markers (screenshot capture,
  // provision bootstrap) — echo them like a real shell would
  if (command.includes("echo captured")) return "captured";
  if (command.includes("echo bootstrapped")) return "bootstrapped";
  return `ran:${command}`;
}

export function startFakeBoxVendor(opts: { token: string }): Promise<FakeBoxVendor> {
  const boxes = new Map<string, FakeBoxRecord>();
  let seq = 0;
  let desktopSeq = 0;
  let base = "";

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const json = (code: number, body: unknown) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.headers.authorization !== `Bearer ${opts.token}`) {
        return json(401, { ok: false, error: "unauthorized" });
      }
      let body: any = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      } catch {
        /* empty body */
      }
      const url = new URL(req.url ?? "/", base);
      const path = url.pathname;

      if (path === "/boxes" && req.method === "GET") {
        return json(200, { ok: true, boxes: [...boxes.values()] });
      }
      if (path === "/boxes" && req.method === "POST") {
        const box: FakeBoxRecord = { id: `box-${++seq}`, name: null, state: "idle", commands: [] };
        boxes.set(box.id, box);
        return json(200, { ok: true, box });
      }
      const m = path.match(/^\/boxes\/([^/]+)(?:\/(commands|files|desktop|stop|resume))?$/);
      const box = m ? boxes.get(m[1]) : undefined;
      if (!m || !box) return json(404, { ok: false, error: "no such box" });

      if (!m[2] && req.method === "GET") return json(200, { ok: true, box });
      if (!m[2] && req.method === "PATCH") {
        if (typeof body.name === "string") box.name = body.name;
        return json(200, { ok: true, box });
      }
      if (!m[2] && req.method === "DELETE") {
        boxes.delete(box.id);
        return json(200, { ok: true });
      }
      if (m[2] === "commands" && req.method === "POST") {
        const command = String(body.command ?? "");
        box.commands.push(command);
        return json(200, { ok: true, exitCode: 0, stdout: commandOutput(command), stderr: "" });
      }
      if (m[2] === "files" && req.method === "GET") {
        const filePath = url.searchParams.get("path") ?? "";
        return json(200, { ok: true, content: Buffer.from(`box file ${filePath}`).toString("base64") });
      }
      if (m[2] === "desktop" && req.method === "POST") {
        // a FRESH url every mint — stream tokens rotate on the real vendor
        return json(200, { ok: true, desktopUrl: `${base}/desktop/${box.id}?stream=${++desktopSeq}` });
      }
      if (m[2] === "stop" && req.method === "POST") {
        box.state = "archived";
        return json(200, { ok: true });
      }
      if (m[2] === "resume" && req.method === "POST") {
        box.state = "idle";
        return json(200, { ok: true });
      }
      return json(404, { ok: false, error: "nope" });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      base = `http://127.0.0.1:${port}`;
      resolve({
        base,
        boxes,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}
