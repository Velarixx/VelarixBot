import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { InternalUserPrincipal } from "../auth.ts";
import { openDatabase } from "../db/database.ts";
import type { SqliteDatabase } from "../db/sqlite-native.ts";
import { IdentitySessions } from "../identity.ts";
import { createRepositories, type Repositories } from "../repositories/index.ts";
import { createDesktopAccessGrantService } from "../services/desktop-access-grants.ts";
import type { RouteHandler } from "./context.ts";
import {
  createSaasDesktopAccessRoutes,
  SAAS_DESKTOP_ACCESS_COOKIE,
  SAAS_DESKTOP_ACCESS_PATH,
} from "./saas-desktop-access.ts";

const WORKSPACE = { providerKind: "fake", machineId: "tenant-machine" };

function invoke(
  handler: RouteHandler,
  principal: InternalUserPrincipal | undefined,
  method: string,
  options: { body?: string; cookie?: string } = {},
): Promise<{ status: number; body: unknown; headers: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    const req = Object.assign(Readable.from(options.body === undefined ? [] : [options.body]), {
      headers: options.cookie ? { cookie: options.cookie } : {},
    }) as IncomingMessage;
    let status = 200;
    const headers: Record<string, string> = {};
    const chunks: Buffer[] = [];
    const res = {
      setHeader(name: string, value: string) { headers[name.toLowerCase()] = String(value); },
      writeHead(code: number, next?: Record<string, string>) {
        status = code;
        for (const [name, value] of Object.entries(next ?? {})) headers[name.toLowerCase()] = String(value);
      },
      end(data?: string | Buffer) {
        if (data) chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve({ status, body: raw ? JSON.parse(raw) : null, headers });
      },
    } as unknown as ServerResponse;
    const url = new URL(`https://app.example${SAAS_DESKTOP_ACCESS_PATH}`);
    Promise.resolve(handler({ req, res, url, path: url.pathname, method, ...(principal ? { principal } : {}) })).catch(reject);
  });
}

describe("SaaS desktop access route", () => {
  let db: SqliteDatabase;
  let repos: Repositories;
  let owner: InternalUserPrincipal;
  let foreignOwner: InternalUserPrincipal;
  let now: number;
  let route: RouteHandler;

  beforeEach(() => {
    db = openDatabase(":memory:");
    repos = createRepositories(db);
    const identities = new IdentitySessions(db);
    owner = { kind: "internal-user", user: { id: identities.upsertGithubIdentity({ githubId: 1, login: "owner" }, 1_000).id } };
    foreignOwner = { kind: "internal-user", user: { id: identities.upsertGithubIdentity({ githubId: 2, login: "foreign" }, 1_000).id } };
    repos.userWorkspaceBindings.forOwner(owner.user.id).record(WORKSPACE.providerKind, WORKSPACE.machineId, 1_000);
    now = 2_000;
    const grants = createDesktopAccessGrantService({
      repos,
      policy: { maxActiveGrantsPerOwner: 2, defaultTtlMs: 1_000, maxTtlMs: 2_000 },
      audit() {},
      now: () => now,
    });
    route = createSaasDesktopAccessRoutes({ forOwner: (ownerId) => grants.forOwner(ownerId) });
  });

  afterEach(() => db.close());

  it("issues and resolves an owner-bound grant without exposing its credential or workspace", async () => {
    const issued = await invoke(route, owner, "POST", { body: "{}" });
    expect(issued).toMatchObject({ status: 201, body: { access: { expiresAt: 3_000 } } });
    expect(issued.headers["cache-control"]).toBe("private, no-store");
    expect(issued.headers["set-cookie"]).toMatch(new RegExp(`^${SAAS_DESKTOP_ACCESS_COOKIE}=[A-Za-z0-9_-]{43};`));
    expect(issued.headers["set-cookie"]).toMatch(/HttpOnly; Secure; SameSite=Strict/);
    expect(JSON.stringify(issued.body)).not.toMatch(/token|provider|machine|workspace|fake|tenant-machine/i);

    const resolved = await invoke(route, owner, "GET", { cookie: issued.headers["set-cookie"] });
    expect(resolved).toMatchObject({ status: 200, body: { access: { expiresAt: 3_000 } } });
    expect(JSON.stringify(resolved.body)).not.toMatch(/token|provider|machine|workspace/i);

    const foreign = await invoke(route, foreignOwner, "GET", { cookie: issued.headers["set-cookie"] });
    expect(foreign).toMatchObject({ status: 410, body: { error: "desktop access expired" } });
  });

  it("denies missing bindings, malformed bodies, and unauthenticated calls generically", async () => {
    expect(await invoke(route, undefined, "POST", { body: "{}" })).toMatchObject({ status: 401 });
    expect(await invoke(route, foreignOwner, "POST", { body: "{}" })).toMatchObject({
      status: 403,
      body: { error: "desktop access unavailable" },
    });
    for (const body of ["", "{ }", "[]", "{", '{"scope":"desktop:control"}', " ".repeat(65)]) {
      expect(await invoke(route, owner, "POST", { body })).toMatchObject({ status: 400, body: { error: "invalid request" } });
    }
    expect(db.prepare<{ n: number }>("SELECT count(*) AS n FROM desktop_access_grants").get()!.n).toBe(0);
  });

  it("expires deterministically and clears the capability cookie", async () => {
    const issued = await invoke(route, owner, "POST", { body: "{}" });
    now = 3_000;
    const expired = await invoke(route, owner, "GET", { cookie: issued.headers["set-cookie"] });
    expect(expired).toMatchObject({ status: 410, body: { error: "desktop access expired" } });
    expect(expired.headers["set-cookie"]).toContain(`${SAAS_DESKTOP_ACCESS_COOKIE}=;`);
    expect(expired.headers["set-cookie"]).toContain("Max-Age=0");
  });

  it("revokes idempotently and makes replay absent", async () => {
    const issued = await invoke(route, owner, "POST", { body: "{}" });
    const cookie = issued.headers["set-cookie"];
    expect(await invoke(route, owner, "DELETE", { cookie })).toMatchObject({ status: 204, body: null });
    expect(await invoke(route, owner, "GET", { cookie })).toMatchObject({ status: 410 });
    expect(await invoke(route, owner, "DELETE", { cookie })).toMatchObject({ status: 204 });
  });

  it("converts internal failures to stable responses without raw detail", async () => {
    const throwing = createSaasDesktopAccessRoutes({
      forOwner() {
        return {
          issue() { throw new Error("provider machine token database secret"); },
          resolve() { throw new Error("provider machine token database secret"); },
          revoke() { throw new Error("provider machine token database secret"); },
        };
      },
    });
    for (const [method, options] of [["POST", { body: "{}" }], ["GET", {}], ["DELETE", {}]] as const) {
      const result = await invoke(throwing, owner, method, options);
      expect(result).toMatchObject({ status: 500, body: { error: "internal server error" } });
      expect(JSON.stringify(result.body)).not.toMatch(/provider|machine|token|database|secret/i);
    }
  });
});
