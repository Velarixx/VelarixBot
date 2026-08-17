// Identity handshake for the packaged app's port fallback: the forked
// child proves it is OURS by echoing its pid (a stray dev server has
// the same API shape but a different pid). `stamp` is the cheap
// current-code proof: rc.3 health had no stamp, so a stale packaged
// server cannot pass release smoke. /api/health is the one route exempt
// from the launch token.
//
// [VERIFY] 2026-08-18 M3: unauthenticated health stays this four-key
// contract — app, pid, static, stamp. Binding P0.3 once accepted
// pid/stamp-only, but current consumers need the rest:
//   - electron/main.mjs identity probe: app === "velarixbot" && pid ===
//     child.pid && static (a stray API-shaped server on the same port
//     must not be adopted)
//   - auth.test.ts pins Object.keys === ["app","pid","stamp","static"]
//   - index.test.ts + smoke-packaged-server.mjs read app/pid/stamp
// Do not strip fields. Do not add versions, fleet, or paths.
import { json, type RouteHandler } from "./context.ts";

export function createHealthRoutes(deps: { staticServing: boolean; stamp: string }): RouteHandler {
  return ({ res, path, method }) => {
    if (method !== "GET" || path !== "/api/health") return false;
    json(res, 200, {
      app: "velarixbot",
      pid: process.pid,
      static: deps.staticServing,
      stamp: deps.stamp,
    });
    return true;
  };
}
