// Shared HTTP plumbing for route modules. Routes receive their services
// from the composition root (server/app.ts) and must not import
// persistence (server/db, server/repositories) — import-hygiene enforces it.
import type { IncomingMessage, ServerResponse } from "node:http";

export interface RouteCtx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  path: string;
  method: string;
}

/** Returns true when the route handled the request. */
export type RouteHandler = (ctx: RouteCtx) => Promise<boolean> | boolean;

export function json(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(data);
}

export function sendBytes(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, {
    "content-type": contentType,
    "cache-control": "private, max-age=3600",
    "content-length": body.length,
  });
  res.end(body);
}

export function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 1_000_000) reject(new Error("body too large"));
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}
