import type { IncomingMessage, ServerResponse } from "node:http";

import type { OwnerDesktopAccessGrantService } from "../services/desktop-access-grants.ts";
import { json, type RouteHandler } from "./context.ts";

export const SAAS_DESKTOP_ACCESS_PATH = "/api/desktop-access";
export const SAAS_DESKTOP_ACCESS_COOKIE = "velarix_desktop_access";
export const SAAS_DESKTOP_ACCESS_SCOPE = "desktop:view" as const;
export const SAAS_DESKTOP_ACCESS_BODY_MAX_BYTES = 64;

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function accessCookie(token: string, maxAgeSeconds: number): string {
  return `${SAAS_DESKTOP_ACCESS_COOKIE}=${token}; Path=${SAAS_DESKTOP_ACCESS_PATH}; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Strict`;
}

function clearAccessCookie(): string {
  return `${SAAS_DESKTOP_ACCESS_COOKIE}=; Path=${SAAS_DESKTOP_ACCESS_PATH}; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}

function tokenFromCookie(header: string | undefined): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== SAAS_DESKTOP_ACCESS_COOKIE) continue;
    const token = part.slice(separator + 1).trim();
    return TOKEN_PATTERN.test(token) ? token : null;
  }
  return null;
}

function hasExactEmptyBody(req: IncomingMessage): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let body = "";
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    req.on("data", (chunk) => {
      body += String(chunk);
      if (Buffer.byteLength(body) > SAAS_DESKTOP_ACCESS_BODY_MAX_BYTES) finish(false);
    });
    req.on("end", () => finish(body === "{}"));
    req.on("error", () => finish(false));
  });
}

function noStore(res: ServerResponse): void {
  res.setHeader("cache-control", "private, no-store");
}

/**
 * Same-origin SaaS capability boundary. The opaque grant lives only in a
 * Secure, HttpOnly, path-scoped cookie. Browser code receives expiry metadata
 * and stable outcomes, never a token, provider/machine identity, join URL, or
 * management credential.
 */
export function createSaasDesktopAccessRoutes(deps: {
  forOwner(ownerId: string): OwnerDesktopAccessGrantService | null;
}): RouteHandler {
  return async ({ req, res, path, method, principal }) => {
    if (path !== SAAS_DESKTOP_ACCESS_PATH || !["GET", "POST", "DELETE"].includes(method)) return false;

    if (principal?.kind !== "internal-user") {
      json(res, 401, { error: "unauthorized" });
      return true;
    }
    const grants = deps.forOwner(principal.user.id);
    if (!grants) {
      json(res, 403, { error: "desktop access unavailable" });
      return true;
    }

    if (method === "POST") {
      if (!(await hasExactEmptyBody(req))) {
        json(res, 400, { error: "invalid request" });
        return true;
      }
      try {
        const issued = grants.issue(SAAS_DESKTOP_ACCESS_SCOPE);
        if (!issued) {
          json(res, 403, { error: "desktop access unavailable" });
          return true;
        }
        const lifetimeSeconds = Math.max(1, Math.ceil((issued.expiresAt - issued.issuedAt) / 1_000));
        res.setHeader("set-cookie", accessCookie(issued.accessToken, lifetimeSeconds));
        noStore(res);
        json(res, 201, { access: { expiresAt: issued.expiresAt } });
      } catch {
        json(res, 500, { error: "internal server error" });
      }
      return true;
    }

    const token = tokenFromCookie(req.headers.cookie);
    if (method === "GET") {
      try {
        const resolved = grants.resolve(token, SAAS_DESKTOP_ACCESS_SCOPE);
        if (!resolved) {
          res.setHeader("set-cookie", clearAccessCookie());
          noStore(res);
          json(res, 410, { error: "desktop access expired" });
          return true;
        }
        noStore(res);
        json(res, 200, { access: { expiresAt: resolved.expiresAt } });
      } catch {
        json(res, 500, { error: "internal server error" });
      }
      return true;
    }

    try {
      grants.revoke(token, SAAS_DESKTOP_ACCESS_SCOPE);
      res.setHeader("set-cookie", clearAccessCookie());
      noStore(res);
      res.writeHead(204);
      res.end();
    } catch {
      json(res, 500, { error: "internal server error" });
    }
    return true;
  };
}
