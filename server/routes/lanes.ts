// Lane scheduler observability + cancel. Snapshot is queued / running /
// cancelled with lane + botId. Cancel drops queued work and can interrupt
// a running turn through the existing interrupt path.
import type { LaneScheduler, SchedulerLane } from "../services/lanes.ts";
import { SCHEDULER_LANES } from "../services/lanes.ts";
import { json, readBody, type RouteHandler } from "./context.ts";

function parseLane(value: unknown): SchedulerLane | undefined {
  return typeof value === "string" && (SCHEDULER_LANES as readonly string[]).includes(value)
    ? (value as SchedulerLane)
    : undefined;
}

export function createLaneRoutes(deps: { lanes: LaneScheduler }): RouteHandler {
  return async ({ req, res, path, method }) => {
    if (method === "GET" && path === "/api/lanes") {
      json(res, 200, deps.lanes.snapshot());
      return true;
    }
    if (method === "POST" && path === "/api/lanes/cancel") {
      const body = await readBody(req).catch(() => ({}));
      const workId = typeof body.workId === "string" ? body.workId : undefined;
      const botId = typeof body.botId === "string" ? body.botId : undefined;
      const lane = parseLane(body.lane);
      if (!workId && !botId && !lane) {
        json(res, 400, { error: "workId, botId, or lane required" });
        return true;
      }
      const result = await deps.lanes.cancel({ workId, botId, lane });
      json(res, 200, { ok: true, cancelled: result.cancelled });
      return true;
    }
    return false;
  };
}
