// User archival for assigned tasks (#148). Cancel / dismiss / obsolete
// go through patchAgentTask. Rows and conversation messages are not deleted.
import { isAgentTaskState, patchAgentTask } from "../agent-tasks.ts";
import type { Broadcast } from "../services/events.ts";
import { json, readBody, type RouteHandler } from "./context.ts";

const USER_TERMINAL = new Set(["cancelled", "stale"]);

export function createAgentTaskRoutes(deps: {
  broadcast?: Broadcast;
  now?: () => number;
}): RouteHandler {
  return async ({ req, res, path, method }) => {
    const match = path.match(/^\/api\/agent-tasks\/([\w-]+)$/);
    if (!match || method !== "PATCH") return false;
    const body = await readBody(req).catch(() => ({}));
    const state = body.state;
    if (!isAgentTaskState(state) || !USER_TERMINAL.has(state)) {
      json(res, 400, { error: "state must be cancelled or stale" });
      return true;
    }
    const reason = typeof body.reason === "string" && body.reason.trim() ? body.reason.trim() : undefined;
    const task = patchAgentTask(match[1], { state, ...(reason ? { reason } : {}) }, deps.now?.());
    if (!task) {
      json(res, 404, { error: "no such task" });
      return true;
    }
    deps.broadcast?.({ kind: "task", task });
    json(res, 200, { task });
    return true;
  };
}
