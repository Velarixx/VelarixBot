// Authenticated SaaS bot catalog. This route deliberately projects a much
// smaller DTO than the desktop PublicBot surface: catalog clients do not get
// database/thread UUIDs, computer bindings, provider configuration, approval
// state, usage, cursors, or any other tenant-internal relationship data.
import type { IncomingMessage } from "node:http";

import type { BotsService, PublicBot } from "../services/bots.ts";
import type { Message } from "../store.ts";
import { json, type RouteHandler } from "./context.ts";

export const SAAS_BOT_CATALOG_MESSAGE_MAX = 20;
export const SAAS_BOT_OWNER_QUOTA = 5;
export const SAAS_BOT_CREATE_BODY_MAX_BYTES = 64;

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

type CatalogSource = Pick<PublicBot, "name" | "title" | "description" | "color" | "messages" | "hasMore">;

function catalogItem(bot: CatalogSource): SaasBotCatalogItem {
  return {
    name: bot.name,
    title: bot.title,
    description: bot.description,
    color: bot.color,
    messages: bot.messages.map(catalogMessage),
    hasMore: bot.hasMore === true,
  };
}

async function hasDefaultOnlyCreateBody(req: IncomingMessage): Promise<boolean> {
  const declaredLength = req.headers["content-length"];
  if (
    Array.isArray(declaredLength) ||
    (declaredLength !== undefined && !/^\d+$/.test(declaredLength)) ||
    (declaredLength !== undefined && Number(declaredLength) > SAAS_BOT_CREATE_BODY_MAX_BYTES)
  ) {
    req.resume();
    return false;
  }

  const chunks: Buffer[] = [];
  let bytes = 0;
  let oversized = false;
  try {
    for await (const value of req) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      bytes += chunk.byteLength;
      if (bytes > SAAS_BOT_CREATE_BODY_MAX_BYTES) {
        oversized = true;
        continue;
      }
      chunks.push(chunk);
    }
  } catch {
    return false;
  }
  if (oversized) return false;

  const raw = Buffer.concat(chunks, bytes).toString("utf8");
  return raw === "{}";
}

/** The only injected process-wide capability is `forOwner`, and the owner
 * key comes exclusively from the authenticated InternalUserPrincipal.
 * Query/header/body identity is never consulted. The sole write is the
 * owner service's quota-bound default creation primitive. */
export function createSaasBotCatalogRoutes(deps: { bots: CatalogBots }): RouteHandler {
  return async ({ req, res, url, path, method, principal }) => {
    if ((method !== "GET" && method !== "POST") || path !== "/api/bots") return false;

    // The application gate normally establishes this invariant. Keeping the
    // route check makes direct invocation and future composition fail closed.
    if (principal?.kind !== "internal-user") {
      json(res, 401, { error: "unauthorized" });
      return true;
    }

    if (method === "POST") {
      if (!(await hasDefaultOnlyCreateBody(req))) {
        json(res, 400, { error: "invalid request" });
        return true;
      }
      try {
        const ownerBots = deps.bots.forOwner(principal.user.id);
        const created = ownerBots.createBotWithinQuota(SAAS_BOT_OWNER_QUOTA);
        if (!created.ok) {
          json(res, 409, { error: "bot quota reached" });
          return true;
        }
        res.setHeader("cache-control", "private, no-store");
        json(res, 201, {
          bot: catalogItem({ ...created.bot, messages: created.onboardingMessages, hasMore: false }),
        });
      } catch {
        json(res, 500, { error: "internal server error" });
      }
      return true;
    }

    try {
      const messages = requestedMessageCount(url);
      if (messages === null) {
        json(res, 400, { error: "messages must be one non-negative whole number" });
        return true;
      }
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
