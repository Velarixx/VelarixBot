import { json, type RouteHandler } from "./context.ts";

/** Minimal authenticated probe with an explicit one-field user allowlist. */
export function createSessionRoutes(): RouteHandler {
  return ({ res, path, method, principal }) => {
    if (method !== "GET" || path !== "/api/session") return false;
    if (!principal || principal.kind !== "internal-user") {
      json(res, 401, { error: "unauthorized" });
      return true;
    }
    res.setHeader("cache-control", "no-store");
    json(res, 200, { user: { id: principal.user.id } });
    return true;
  };
}
