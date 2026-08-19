// Authenticated SaaS bot catalog. This route deliberately projects a much
// smaller DTO than the desktop PublicBot surface: catalog clients do not get
// database/thread UUIDs, computer bindings, provider configuration, approval
// state, usage, cursors, or any other tenant-internal relationship data.
import type { BotsService, PublicBot } from "../services/bots.ts";
import type { Message } from "../store.ts";
import { json, type RouteHandler } from "./context.ts";

export const SAAS_BOT_CATALOG_MESSAGE_MAX = 20;

export interface SaasBotCatalogMessage {
  role: Message["role"];
  kind: Message["kind"];
  text?: string;
  at: number;
}

export interface SaasBotCatalogItem {
  name: string;
  title: string;
  description: string;
  color: PublicBot["color"];
  messages: SaasBotCatalogMessage[];
  hasMore: boolean;
}

type CatalogBots = Pick<BotsService, "forOwner">;

function requestedMessageCount(url: URL): number | null {
  const values = url.searchParams.getAll("messages");
  if (values.length === 0) return 0;
  if (values.length !== 1 || !/^\d+$/.test(values[0])) return null;
  const count = Number(values[0]);
  if (!Number.isSafeInteger(count)) return null;
  return Math.min(count, SAAS_BOT_CATALOG_MESSAGE_MAX);
}

function catalogMessage(message: Message): SaasBotCatalogMessage {
  return {
    role: message.role,
    kind: message.kind,
    ...(typeof message.text === "string" ? { text: message.text } : {}),
    at: message.at,
  };
}

function catalogItem(bot: PublicBot): SaasBotCatalogItem {
  return {
    name: bot.name,
    title: bot.title,
    description: bot.description,
    color: bot.color,
    messages: bot.messages.map(catalogMessage),
    hasMore: bot.hasMore === true,
  };
}

/**
 * Read-only by construction: the only injected process-wide capability is
 * `forOwner`, and the owner key comes exclusively from the authenticated
 * InternalUserPrincipal. Query/header/body identity is never consulted.
 */
export function createSaasBotCatalogRoutes(deps: { bots: CatalogBots }): RouteHandler {
  return ({ res, url, path, method, principal }) => {
    if (method !== "GET" || path !== "/api/bots") return false;

    // The application gate normally establishes this invariant. Keeping the
    // route check makes direct invocation and future composition fail closed.
    if (principal?.kind !== "internal-user") {
      json(res, 401, { error: "unauthorized" });
      return true;
    }

    const messages = requestedMessageCount(url);
    if (messages === null) {
      json(res, 400, { error: "messages must be one non-negative whole number" });
      return true;
    }

    try {
      const ownerBots = deps.bots.forOwner(principal.user.id);
      const bots = ownerBots.publicBots({ messages }).map(catalogItem);
      res.setHeader("cache-control", "private, no-store");
      json(res, 200, { bots });
    } catch {
      // Do not serialize repository/provider errors or identity-bearing detail.
      json(res, 500, { error: "internal server error" });
    }
    return true;
  };
}
