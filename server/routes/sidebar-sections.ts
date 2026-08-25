// Conversations sidebar sections: first-class { id, name } list plus
// collapse keys. Membership is bot.sectionId — never Title.
import type { BotsService } from "../services/bots.ts";
import type { Broadcast } from "../services/events.ts";
import {
  createSidebarSection,
  deleteSidebarSection,
  readSidebarSections,
  renameSidebarSection,
  writeCollapsedSectionKeys,
} from "../sidebar-sections.ts";
import { json, readBody, type RouteHandler } from "./context.ts";

function unassignBots(bots: BotsService, broadcast: Broadcast, sectionId: string): void {
  for (const bot of bots.bots()) {
    if (bot.sectionId !== sectionId) continue;
    const updated = bots.patchBot(bot.id, { sectionId: null });
    if (!updated) continue;
    broadcast({ kind: "bot", bot: bots.publicBot(updated.id) ?? updated });
  }
}

export function createSidebarSectionsRoutes(deps: {
  bots: BotsService;
  broadcast: Broadcast;
}): RouteHandler {
  const { bots, broadcast } = deps;
  return async ({ req, res, path, method }) => {
    if (path === "/api/sidebar-sections" && method === "GET") {
      json(res, 200, readSidebarSections());
      return true;
    }
    if (path === "/api/sidebar-sections" && method === "POST") {
      const body = await readBody(req);
      const created = createSidebarSection(body.name);
      if (!created.ok) {
        json(res, created.status, { error: created.error });
        return true;
      }
      json(res, 201, { section: created.section, ...readSidebarSections() });
      return true;
    }
    if (path === "/api/sidebar-sections/collapsed" && method === "PUT") {
      const body = await readBody(req);
      const written = writeCollapsedSectionKeys(body.collapsed);
      if (!written.ok) {
        json(res, written.status, { error: written.error });
        return true;
      }
      json(res, 200, readSidebarSections());
      return true;
    }
    const match = path.match(/^\/api\/sidebar-sections\/([\w-]+)$/);
    if (match && method === "PATCH") {
      const body = await readBody(req);
      const renamed = renameSidebarSection(match[1], body.name);
      if (!renamed.ok) {
        json(res, renamed.status, { error: renamed.error });
        return true;
      }
      json(res, 200, { section: renamed.section, ...readSidebarSections() });
      return true;
    }
    if (match && method === "DELETE") {
      const removed = deleteSidebarSection(match[1]);
      if (!removed.ok) {
        json(res, removed.status, { error: removed.error });
        return true;
      }
      unassignBots(bots, broadcast, removed.section.id);
      json(res, 200, { ok: true, ...readSidebarSections() });
      return true;
    }
    return false;
  };
}
