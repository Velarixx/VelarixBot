// The one SSE stream every client folds. Token-gated like the rest of
// /api/* (the auth gate runs before this route).
import type { SseHub } from "../services/events.ts";
import type { RouteHandler } from "./context.ts";

export function createEventsRoutes(deps: { hub: SseHub }): RouteHandler {
  return ({ req, res, path, method }) => {
    if (method !== "GET" || path !== "/api/events") return false;
    deps.hub.attach(req, res);
    return true;
  };
}
