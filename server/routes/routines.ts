// Persistent routines CRUD + manual run.
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
    match = path.match(/^\/api\/routines\/([\w-]+)\/run$/);
    if (match && method === "POST") {
      await routines.runRoutine(match[1]);
      json(res, 202, { ok: true });
      return true;
    }
    return false;
  };
}
