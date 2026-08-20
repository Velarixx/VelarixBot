import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash } from "node:crypto";

import type { ComputerViewerFrame } from "../computer/provider.ts";
import type { OwnerDesktopAccessGrantService } from "../services/desktop-access-grants.ts";
import type { OwnerDesktopViewerBroker } from "../services/desktop-viewer-broker.ts";
import { json, type RouteHandler } from "./context.ts";

export const SAAS_DESKTOP_ACCESS_PATH = "/api/desktop-access";
export const SAAS_DESKTOP_VIEWER_PATH = `${SAAS_DESKTOP_ACCESS_PATH}/view`;
export const SAAS_DESKTOP_ACCESS_COOKIE = "velarix_desktop_access";
export const SAAS_DESKTOP_ACCESS_SCOPE = "desktop:view" as const;
export const SAAS_DESKTOP_ACCESS_BODY_MAX_BYTES = 64;

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const VIEWER_BOUNDARY = "velarix-desktop-frame";
const VIEWER_FRAME_MAX_BYTES = 8 * 1024 * 1024;

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

function tokenKey(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function encodedFrame(frame: ComputerViewerFrame): { bytes: Buffer; contentType: string } {
  const bytes = Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength);
  if (bytes.length < 3 || bytes.length > VIEWER_FRAME_MAX_BYTES) throw new Error("invalid viewer frame");
  if (frame.format === "png") {
    if (bytes.length < 8 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
      throw new Error("invalid viewer frame");
    }
    return { bytes, contentType: "image/png" };
  }
  if (frame.format === "jpeg" && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { bytes, contentType: "image/jpeg" };
  }
  throw new Error("invalid viewer frame");
}

async function writeFrame(res: ServerResponse, frame: ComputerViewerFrame): Promise<void> {
  const { bytes, contentType } = encodedFrame(frame);
  const prefix = Buffer.from(
    `--${VIEWER_BOUNDARY}\r\nContent-Type: ${contentType}\r\nContent-Length: ${bytes.length}\r\n\r\n`,
  );
  const prefixAccepted = res.write(prefix);
  const bytesAccepted = res.write(bytes);
  const suffixAccepted = res.write("\r\n");
  const backpressured = !prefixAccepted || !bytesAccepted || !suffixAccepted;
  if (backpressured) {
    if (res.destroyed || res.writableEnded) throw new Error("viewer disconnected");
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        res.removeListener("drain", onDrain);
        res.removeListener("close", onClose);
      };
      const onDrain = () => {
        cleanup();
        resolve();
      };
      const onClose = () => {
        cleanup();
        reject(new Error("viewer disconnected"));
      };
      res.once("drain", onDrain);
      res.once("close", onClose);
    });
  }
}

function viewerUnavailable(res: ServerResponse): void {
  noStore(res);
  json(res, 404, { error: "desktop viewer unavailable" });
}

function viewerFailure(res: ServerResponse): void {
  noStore(res);
  json(res, 503, { error: "desktop viewer unavailable" });
}

/**
 * Same-origin SaaS capability boundary. The opaque grant lives only in a
 * Secure, HttpOnly, path-scoped cookie. Browser code receives expiry metadata
 * and stable outcomes, never a token, provider/machine identity, join URL, or
 * management credential.
 */
export function createSaasDesktopAccessRoutes(deps: {
  forOwner(ownerId: string): OwnerDesktopAccessGrantService | null;
  viewerForOwner?(ownerId: string): OwnerDesktopViewerBroker | null;
  now?: () => number;
}): RouteHandler {
  const now = deps.now ?? Date.now;
  const activeViewers = new Map<string, Set<AbortController>>();

  const trackViewer = (token: string, controller: AbortController) => {
    const key = tokenKey(token);
    const controllers = activeViewers.get(key) ?? new Set<AbortController>();
    controllers.add(controller);
    activeViewers.set(key, controllers);
    return () => {
      controllers.delete(controller);
      if (controllers.size === 0) activeViewers.delete(key);
    };
  };
  const closeViewers = (token: string | null) => {
    if (!token) return;
    const key = tokenKey(token);
    for (const controller of activeViewers.get(key) ?? []) controller.abort();
    activeViewers.delete(key);
  };

  return async ({ req, res, path, method, principal }) => {
    const isViewer = path === SAAS_DESKTOP_VIEWER_PATH && method === "GET";
    if (!isViewer && (path !== SAAS_DESKTOP_ACCESS_PATH || !["GET", "POST", "DELETE"].includes(method))) return false;

    if (principal?.kind !== "internal-user") {
      json(res, 401, { error: "unauthorized" });
      return true;
    }
    const grants = deps.forOwner(principal.user.id);
    if (!grants) {
      json(res, 403, { error: "desktop access unavailable" });
      return true;
    }

    if (isViewer) {
      const token = tokenFromCookie(req.headers.cookie);
      const viewer = deps.viewerForOwner?.(principal.user.id);
      if (!token || !viewer) {
        viewerUnavailable(res);
        return true;
      }

      const controller = new AbortController();
      const untrack = trackViewer(token, controller);
      const close = () => controller.abort();
      req.once("aborted", close);
      res.once("close", close);
      let headersSent = false;
      let expiryTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        const opened = await viewer.open(token, controller.signal);
        if (!opened) {
          viewerUnavailable(res);
          return true;
        }
        const initial = encodedFrame(opened.connection.initialFrame);
        const remainingMs = Math.max(0, opened.expiresAt - now());
        expiryTimer = setTimeout(close, remainingMs);
        res.writeHead(200, {
          "content-type": `multipart/x-mixed-replace; boundary=${VIEWER_BOUNDARY}`,
          "cache-control": "private, no-store",
          "content-security-policy": "default-src 'none'; frame-ancestors 'self'; sandbox",
          "referrer-policy": "no-referrer",
          "x-content-type-options": "nosniff",
          "x-frame-options": "SAMEORIGIN",
        });
        headersSent = true;
        await writeFrame(res, { data: initial.bytes, format: opened.connection.initialFrame.format });
        for await (const frame of opened.connection.frames) {
          if (controller.signal.aborted) break;
          await writeFrame(res, frame);
        }
      } catch {
        if (!headersSent) viewerFailure(res);
      } finally {
        if (expiryTimer) clearTimeout(expiryTimer);
        req.removeListener("aborted", close);
        res.removeListener("close", close);
        controller.abort();
        untrack();
        if (headersSent && !res.writableEnded) res.end();
      }
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
      closeViewers(token);
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
