// P1.7 diagnostics surface, behind the launch-token gate like every other
// /api route (only /api/health is exempt):
//   GET  /api/diagnostics/export — the redacted support bundle (versions,
//        capabilities, redacted logs, integrity result; never transcripts)
//   POST /api/diagnostics/backup — one-click verified archive of the
//        profile (db + approvals/skills/memory + config/secrets) into
//        ~/.velarixbot/backup/
import type { DiagnosticsService } from "../services/diagnostics.ts";
import { json, type RouteHandler } from "./context.ts";

export function createDiagnosticsRoutes(deps: { diagnostics: DiagnosticsService }): RouteHandler {
  const { diagnostics } = deps;
  return async ({ res, path, method }) => {
    if (method === "GET" && path === "/api/diagnostics/export") {
      json(res, 200, await diagnostics.exportBundle());
      return true;
    }
    if (method === "POST" && path === "/api/diagnostics/backup") {
      json(res, 200, diagnostics.backupNow());
      return true;
    }
    return false;
  };
}
