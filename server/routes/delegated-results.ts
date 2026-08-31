// Manual retry for stored failed delegated-result deliveries (#150 P0).
// Delivery retry never starts a worker turn.
import type { DelegatedResultsService } from "../services/delegated-results.ts";
import { json, type RouteHandler } from "./context.ts";

export function createDelegatedResultsRoutes(deps: { delegatedResults: DelegatedResultsService }): RouteHandler {
  return ({ res, path, method }) => {
    const match = path.match(/^\/api\/agent-task-deliveries\/([\w:-]+)\/retry$/);
    if (!match || method !== "POST") return false;
    const result = deps.delegatedResults.retryFailed(match[1]);
    if (!result.ok) {
      json(res, result.status, { error: result.error, code: result.code });
      return true;
    }
    json(res, 200, {
      ok: true,
      deliveryId: result.delivery.id,
      runId: result.delivery.runId,
      deliveryState: result.delivery.deliveryState,
      failureCode: result.delivery.failureCode,
      attempts: result.delivery.attempts,
    });
    return true;
  };
}
