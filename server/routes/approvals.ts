// Approval rules: list + revoke + reconfirm (Always-allow writes them via
// the respond flow). The P0.1 consent semantics live in approvals.ts.
import { confirmRule, deleteRule, listRules, redactSecrets } from "../approvals.ts";
import type { BotsService } from "../services/bots.ts";
import { json, readBody, type RouteHandler } from "./context.ts";

export function createApprovalsRoutes(deps: { bots: BotsService }): RouteHandler {
  const { bots } = deps;
  return async ({ req, res, path, method }) => {
    let match = path.match(/^\/api\/bots\/([\w-]+)\/approvals$/);
    if (match && method === "GET") {
      if (!bots.bot(match[1])) {
        json(res, 404, { error: "no such bot" });
        return true;
      }
      json(res, 200, { rules: listRules(match[1]) });
      return true;
    }
    match = path.match(/^\/api\/bots\/([\w-]+)\/approvals\/([\w-]+)$/);
    if (match && method === "DELETE") {
      if (!bots.bot(match[1])) {
        json(res, 404, { error: "no such bot" });
        return true;
      }
      if (deleteRule(match[1], match[2])) json(res, 200, { ok: true });
      else json(res, 404, { error: "no such rule" });
      return true;
    }
    // Settings reconfirmation of a quarantined legacy rule — the only patch
    // supported is {confirmed:true}; rules are otherwise immutable.
    if (match && method === "PATCH") {
      if (!bots.bot(match[1])) {
        json(res, 404, { error: "no such bot" });
        return true;
      }
      const body = await readBody(req);
      if (body.confirmed !== true) {
        json(res, 400, { error: "only {confirmed:true} is supported" });
        return true;
      }
      const rule = confirmRule(match[1], match[2]);
      if (rule) json(res, 200, { rule: { ...rule, pattern: redactSecrets(rule.pattern) } });
      else json(res, 404, { error: "no such rule" });
      return true;
    }
    return false;
  };
}
