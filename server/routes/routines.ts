// Persistent routines CRUD + manual test run + run history.
import type { RoutinesService } from "../services/routines.ts";
import { json, readBody, type RouteHandler } from "./context.ts";

export function createRoutinesRoutes(deps: { routines: RoutinesService }): RouteHandler {
  const { routines } = deps;
  return async ({ req, res, path, method }) => {
    if (method === "GET" && path === "/api/routines") {
      json(res, 200, { routines: routines.routines() });
      return true;
    }
    if (method === "POST" && path === "/api/routines") {
      const body = await readBody(req);
      json(res, 201, {
        routine: routines.createRoutine({
          botId: String(body.botId ?? ""),
          name: String(body.name ?? ""),
          prompt: String(body.prompt ?? ""),
          schedule: body.schedule,
          missedPolicy: body.missedPolicy,
          thenStartTurn: body.thenStartTurn,
          skillId: body.skillId,
        }),
      });
      return true;
    }
    let match = path.match(/^\/api\/routines\/([\w-]+)$/);
    if (match && method === "PATCH") {
      const body = await readBody(req);
      const routine = routines.patchRoutine(match[1], {
        name: body.name,
        prompt: body.prompt,
        schedule: body.schedule,
        enabled: body.enabled,
        missedPolicy: body.missedPolicy,
        thenStartTurn: body.thenStartTurn,
        skillId: body.skillId,
      });
      if (routine) json(res, 200, { routine });
      else json(res, 404, { error: "no such routine" });
      return true;
    }
    if (match && method === "DELETE") {
      if (routines.deleteRoutine(match[1])) json(res, 200, { ok: true });
      else json(res, 404, { error: "no such routine" });
      return true;
    }
    match = path.match(/^\/api\/routines\/([\w-]+)\/runs$/);
    if (match && method === "GET") {
      if (!routines.routine(match[1])) {
        json(res, 404, { error: "no such routine" });
        return true;
      }
      json(res, 200, {
        runs: routines.runs(match[1]).map((run) => ({
          seq: run.seq,
          startedAt: run.started_at,
          finishedAt: run.finished_at,
          scheduledFor: run.scheduled_for,
          kind: run.kind,
          status: run.status,
          attempt: run.attempt,
          result: run.result,
        })),
      });
      return true;
    }
    match = path.match(/^\/api\/routines\/([\w-]+)\/run$/);
    if (match && method === "POST") {
      const body = await readBody(req).catch(() => ({}));
      const prompt = typeof body.prompt === "string" && body.prompt.trim() ? body.prompt.trim() : undefined;
      const outcome = await routines.runRoutine(match[1], prompt ? { prompt } : undefined);
      if (outcome.started) json(res, 202, { ok: true });
      else if (outcome.reason === "no such routine") json(res, 404, { error: outcome.reason });
      else json(res, 409, { error: outcome.reason ?? "not started" });
      return true;
    }
    return false;
  };
}
