// P1.7 diagnostics surface, behind the launch-token gate like every other
// /api route (only /api/health is exempt):
//   GET  /api/diagnostics/export — the redacted support bundle (versions,
//        capabilities, redacted logs, integrity result; never transcripts)
//   POST /api/diagnostics/backup — one-click verified archive of the
//        profile (db + approvals/skills/memory + config/secrets) into
//        ~/.velarixbot/backup/
// P7 local diagnostics (no remote telemetry):
//   GET  /api/diagnostics/lineage/:requestId — one request's inbound→turn→tools→outbound
//   GET  /api/usage — local per-provider activity counts for App Settings
import type { DiagnosticsService } from "../services/diagnostics.ts";
import type { LineageService } from "../services/lineage.ts";
import type { UsageService } from "../services/usage.ts";
import { json, type RouteHandler } from "./context.ts";

export function createDiagnosticsRoutes(deps: {
  diagnostics: DiagnosticsService;
  lineage?: LineageService;
  usage?: UsageService;
}): RouteHandler {
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
    const lineageMatch = path.match(/^\/api\/diagnostics\/lineage\/([^/]+)$/);
    if (method === "GET" && lineageMatch) {
      const view = deps.lineage?.publicView(decodeURIComponent(lineageMatch[1]));
      if (!view) {
        json(res, 404, { error: "unknown request" });
        return true;
      }
      json(res, 200, view);
      return true;
    }
    if (method === "GET" && path === "/api/usage") {
      json(res, 200, { providers: deps.usage?.totals() ?? [] });
      return true;
    }
    return false;
  };
}
