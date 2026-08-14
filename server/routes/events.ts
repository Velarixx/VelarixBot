// The one SSE stream every client folds. Token-gated like the rest of
// /api/* (the auth gate runs before this route).
//
// P1.3 resume surface:
//   GET /api/events?lastEventId=N   — resume from a cursor (fresh
//       EventSource after a renderer reload; the browser cannot set the
//       Last-Event-ID header itself). An auto-reconnect's Last-Event-ID
//       header takes precedence inside the hub.
//   GET /api/events/snapshot        — full state + the ui-stream cursor it
//       was taken at: hydrate from the snapshot, subscribe from its
//       cursor, and nothing is lost or applied twice.
import type { BotsService } from "../services/bots.ts";
import type { SseHub } from "../services/events.ts";
import { json, type RouteHandler } from "./context.ts";

export function createEventsRoutes(deps: { hub: SseHub; bots: BotsService }): RouteHandler {
  const { hub, bots } = deps;
  return ({ req, res, url, path, method }) => {
    if (method !== "GET") return false;
    if (path === "/api/events") {
      hub.attach(req, res, url.searchParams.get("lastEventId"));
      return true;
    }
    if (path === "/api/events/snapshot") {
      // cursor BEFORE state: an event landing after this cursor is replayed
      // on subscribe; one landing before it is inside the snapshot
      const cursor = hub.cursor();
      json(res, 200, {
        ...cursor,
        bots: bots.bots().map((b) => ({ ...b, messages: bots.messagesFor(b.threadId) })),
      });
      return true;
    }
    return false;
  };
}
