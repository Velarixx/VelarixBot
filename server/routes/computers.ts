// The bot's cloud computer (Box) panel endpoints. The bot→box binding is
// recorded through the composition root (routes never touch persistence).
import * as box from "../box.ts";
import type { AppConfig } from "../config.ts";
import type { BotsService } from "../services/bots.ts";
import { json, readBody, type RouteHandler } from "./context.ts";

export function createComputersRoutes(deps: {
  bots: BotsService;
  cfg: AppConfig;
  recordBinding(botId: string, boxId: string): void;
}): RouteHandler {
  const { bots, cfg, recordBinding } = deps;
  return async ({ req, res, path, method }) => {
    let m = path.match(/^\/api\/bots\/([\w-]+)\/computer$/);
    if (m && method === "GET") {
      json(res, 200, await box.boxStatus(cfg, m[1]));
      return true;
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/computer\/(provision|join|sleep|exec|screenshot)$/);
    if (m && method === "POST") {
      const botId = m[1];
      const bot = bots.bot(botId);
      if (!bot) {
        json(res, 404, { error: "no such bot" });
        return true;
      }
      switch (m[2]) {
        case "provision": {
          const provisioned = await box.provisionBox(cfg, botId, bot.name);
          recordBinding(botId, provisioned.boxId);
          json(res, 200, provisioned);
          return true;
        }
        case "join":
          json(res, 200, await box.joinBox(cfg, botId));
          return true;
        case "sleep":
          json(res, 200, await box.sleepBox(cfg, botId));
          return true;
        case "exec": {
          const body = await readBody(req);
          json(res, 200, await box.execOnBox(cfg, botId, String(body.command ?? "")));
          return true;
        }
        case "screenshot":
          json(res, 200, await box.screenshotBox(cfg, botId));
          return true;
      }
    }
    return false;
  };
}
