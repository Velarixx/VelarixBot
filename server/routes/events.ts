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
//   GET /api/events/snapshot?messages=n — same, but newest n per thread
//       (slim screens). Omitting the query is the original full transcript.
import type { BotsService } from "../services/bots.ts";
import type { SseHub } from "../services/events.ts";
import { json, parsePageSize, type RouteHandler } from "./context.ts";

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
      const limit = parsePageSize(url.searchParams.get("messages"));
      if (limit === null) {
        json(res, 400, { error: "messages must be a non-negative whole number" });
        return true;
      }
      const cursor = hub.cursor();
      json(res, 200, {
        ...cursor,
        bots: bots.publicBots(limit === undefined ? undefined : { messages: limit }),
      });
      return true;
    }
    return false;
  };
}
