// Read-only channel-connector registry/status. No Discord connect UI,
// no token writes, no outbound send from HTTP this PR.
import type { ChannelsService } from "../services/channels.ts";
import { json, type RouteHandler } from "./context.ts";

export function createChannelsRoutes(deps: { channels: ChannelsService }): RouteHandler {
  return ({ res, path, method }) => {
    if (method === "GET" && path === "/api/channels") {
      json(res, 200, { connectors: deps.channels.list() });
      return true;
    }
    const one = path.match(/^\/api\/channels\/([\w-]+)$/);
    if (method === "GET" && one) {
      const status = deps.channels.status(one[1]);
      if (!status) {
        json(res, 404, { error: "channel connector not found" });
        return true;
      }
      json(res, 200, { connector: status });
      return true;
    }
    return false;
  };
}
