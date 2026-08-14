// SSE fan-out to clients. One hub per application; routes attach response
// streams, services broadcast frames.
import type { IncomingMessage, ServerResponse } from "node:http";

export type Broadcast = (payload: unknown) => void;

export interface SseHub {
  broadcast: Broadcast;
  attach(req: IncomingMessage, res: ServerResponse): void;
  clientCount(): number;
}

export function createSseHub(): SseHub {
  const clients = new Set<ServerResponse>();
  return {
    broadcast(payload) {
      const frame = `data: ${JSON.stringify(payload)}\n\n`;
      for (const res of [...clients]) {
        try {
          res.write(frame);
        } catch {
          clients.delete(res);
        }
      }
    },
    attach(req, res) {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(`data: ${JSON.stringify({ kind: "hello" })}\n\n`);
      clients.add(res);
      const keepalive = setInterval(() => {
        try {
          res.write(": keepalive\n\n");
        } catch {
          /* client is gone; close handler cleans up */
        }
      }, 25_000);
      req.on("close", () => {
        clearInterval(keepalive);
        clients.delete(res);
      });
    },
    clientCount() {
      return clients.size;
    },
  };
}
