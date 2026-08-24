import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSourceFile,
  forEachChild,
  isBinaryExpression,
  isIfStatement,
  isRegularExpressionLiteral,
  isStringLiteralLike,
  isVariableDeclaration,
  ScriptKind,
  ScriptTarget,
  type Node,
} from "typescript";
import { afterAll, beforeAll, describe, expect, it, vi, type MockInstance } from "vitest";

import { createApplication, type Application } from "./app.ts";
import { BoxComputerProviderFactory, boxMaintenance } from "./computer/box.ts";
import type { ComputerProvider } from "./computer/provider.ts";
import type { ComputerRegistry } from "./computer/registry.ts";
import type { AppConfig } from "./config.ts";
import { openDatabase } from "./db/database.ts";
import type { SqliteDatabase } from "./db/sqlite-native.ts";
import { EventBus } from "./harness/bus.ts";
import { ProviderRegistry } from "./harness/registry.ts";
import { IdentitySessions, SESSION_COOKIE_NAME } from "./identity.ts";
import type { GithubOAuthProvider } from "./oauth/github-provider.ts";
import { createRepositories } from "./repositories/index.ts";
import { bestEffortRm } from "./testing/harness.ts";

const APPLICATION_ORIGIN = "https://app.velarix.test";
const NOW = 1_800_000_000_000;
const DESKTOP_TOKEN = "route-surface-desktop-token";
const COMMS_TOKEN = "route-surface-comms-token";

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

interface DeniedRoute {
  family: string;
  method: Method;
  path: string;
}

// This hashes only API literals, route regexes, and method/path predicates,
// rather than whole files, so implementation-only edits do not churn it. A
// failure requires reviewing deniedRoutes + the approved SaaS routes before
// accepting the new digest; otherwise a production route cannot land silently.
const PRODUCTION_ROUTE_INVENTORY_SHA256 = "97d2639d7b86f1ee42cefa6a1dc35357aabd7702c81cad888222ec7705ecdb47";

function productionRouteTokens(): string[] {
  const routesDirectory = new URL("./routes/", import.meta.url);
  const tokens: string[] = [];
  for (const file of readdirSync(routesDirectory).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))) {
    const source = readFileSync(new URL(file, routesDirectory), "utf8");
    const sourceFile = createSourceFile(file, source, ScriptTarget.Latest, false, ScriptKind.TS);
    const visit = (node: Node) => {
      if (isStringLiteralLike(node) && node.text.startsWith("/api/")) tokens.push(`${file}:string:${node.text}`);
      if (isRegularExpressionLiteral(node) && node.text.startsWith("/^\\/api\\/")) tokens.push(`${file}:regex:${node.text}`);
      if (isIfStatement(node)) {
        const predicate = node.expression.getText(sourceFile).replace(/\s+/g, " ");
        if (/(?:^|[^\w.])(?:method|path)\b/.test(predicate)) tokens.push(`${file}:if:${predicate}`);
      }
      if (isVariableDeclaration(node) && node.initializer && isBinaryExpression(node.initializer)) {
        const predicate = node.initializer.getText(sourceFile).replace(/\s+/g, " ");
        if (/\bmethod\b/.test(predicate) && /\bpath\b/.test(predicate)) {
          tokens.push(`${file}:variable:${node.name.getText(sourceFile)}=${predicate}`);
        }
      }
      forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return tokens.sort();
}

function productionRouteInventoryDigest(tokens: string[]): string {
  return createHash("sha256").update(tokens.join("\n")).digest("hex");
}

function route(family: string, method: Method, path: string): DeniedRoute {
  return { family, method, path };
}

function deniedRoutes(botId: string): DeniedRoute[] {
  const ruleId = "rule-probe";
  const routineId = "routine-probe";
  const messageId = "message-probe";
  return [
    route("events/SSE", "GET", "/api/events"),
    route("events/SSE", "GET", "/api/events/snapshot?messages=1"),

    route("routines", "GET", "/api/routines"),
    route("routines", "POST", "/api/routines"),
    route("routines", "PATCH", `/api/routines/${routineId}`),
    route("routines", "DELETE", `/api/routines/${routineId}`),
    route("routines", "GET", `/api/routines/${routineId}/runs`),
    route("routines", "POST", `/api/routines/${routineId}/run`),

    route("approvals", "GET", `/api/bots/${botId}/approvals`),
    route("approvals", "PATCH", `/api/bots/${botId}/approvals/${ruleId}`),
    route("approvals", "DELETE", `/api/bots/${botId}/approvals/${ruleId}`),

    route("bot detail/mutation", "GET", `/api/bots/${botId}`),
    route("bot detail/mutation", "PATCH", `/api/bots/${botId}`),
    route("bot detail/mutation", "DELETE", `/api/bots/${botId}`),
    route("bot detail/mutation", "PATCH", `/api/bots/${botId}/cards/${messageId}`),
    route("bot detail/mutation", "POST", `/api/bots/${botId}/avatar/generate`),
    route("bot detail/mutation", "GET", `/api/bots/${botId}/avatar`),
    route("bot detail/mutation", "GET", `/api/bots/${botId}/avatar/${"a".repeat(64)}`),
    route("bot detail/mutation", "GET", `/api/bots/${botId}/memory`),
    route("bot detail/mutation", "PATCH", `/api/bots/${botId}/memory`),
    route("bot detail/mutation", "PUT", `/api/bots/${botId}/memory`),
    route("bot detail/mutation", "POST", `/api/bots/${botId}/memory/forget`),
    route("bot detail/mutation", "POST", `/api/bots/${botId}/memory/rows`),
    route("bot detail/mutation", "PATCH", `/api/bots/${botId}/memory/rows/memory-row-probe`),
    route("bot detail/mutation", "PUT", `/api/bots/${botId}/memory/rows/memory-row-probe`),
    route("bot detail/mutation", "DELETE", `/api/bots/${botId}/memory/rows/memory-row-probe`),
    route("bot detail/mutation", "GET", `/api/threads/thread-probe/messages`),
    route("bot detail/mutation", "GET", `/api/threads/thread-probe/messages/${messageId}/image`),
    route("bot detail/mutation", "GET", "/api/skills"),
    route("bot detail/mutation", "POST", "/api/skills"),
    route("bot detail/mutation", "GET", "/api/skills/skill-probe"),
    route("bot detail/mutation", "PATCH", "/api/skills/skill-probe"),
    route("bot detail/mutation", "DELETE", "/api/skills/skill-probe"),
    route("bot detail/mutation", "GET", "/api/teach-sessions"),
    route("bot detail/mutation", "GET", `/api/bots/${botId}/teach`),
    route("bot detail/mutation", "POST", `/api/bots/${botId}/teach/start`),
    route("bot detail/mutation", "POST", `/api/bots/${botId}/teach/stop`),
    route("bot detail/mutation", "POST", `/api/bots/${botId}/teach/save`),
    route("bot detail/mutation", "POST", `/api/bots/${botId}/teach/discard`),

    route("turns", "POST", `/api/bots/${botId}/messages`),
    route("turns", "POST", `/api/bots/${botId}/respond`),
    route("turns", "POST", `/api/bots/${botId}/interrupt`),

    route("lanes", "GET", "/api/lanes"),
    route("lanes", "POST", "/api/lanes/cancel"),

    route("diagnostics", "GET", "/api/diagnostics/export"),
    route("diagnostics", "POST", "/api/diagnostics/backup"),

    route("channels", "GET", "/api/channels"),
    route("channels", "GET", "/api/channels/connector-probe"),

    route("integrations", "GET", "/api/instances"),
    route("integrations", "PATCH", "/api/instances/instance-probe"),
    route("integrations", "GET", "/api/config"),
    route("integrations", "PUT", "/api/config"),
    route("integrations", "PATCH", "/api/config"),
    route("integrations", "GET", "/api/bitwarden"),
    route("integrations", "POST", "/api/bitwarden/disconnect"),
    route("integrations", "GET", "/api/connectors/catalog"),
    route("integrations", "GET", "/api/connectors/sessions"),
    route("integrations", "POST", "/api/connectors/sessions"),
    route("integrations", "DELETE", "/api/connectors/sessions/session-probe"),
    route("integrations", "GET", `/api/connectors?botId=${botId}`),
    route("integrations", "POST", `/api/connectors/github/authorize?botId=${botId}`),
    route("integrations", "DELETE", `/api/connectors/github?botId=${botId}`),

    route("computer cleanup", "GET", "/api/computer/cleanup"),
    route("computer cleanup", "POST", "/api/computer/cleanup"),
    route("bot computer", "GET", `/api/bots/${botId}/computer`),
    route("bot computer", "POST", `/api/bots/${botId}/computer/provision`),
    route("bot computer", "POST", `/api/bots/${botId}/computer/join`),
    route("bot computer", "POST", `/api/bots/${botId}/computer/sleep`),
    route("bot computer", "POST", `/api/bots/${botId}/computer/exec`),
    route("bot computer", "POST", `/api/bots/${botId}/computer/screenshot`),

    route("unmounted remote access", "GET", "/api/computers"),
    route("unmounted remote access", "POST", "/api/vms"),
    route("unmounted remote access", "GET", `/api/bots/${botId}/ssh`),
    route("unmounted remote access", "GET", `/api/bots/${botId}/vnc`),
    route("unmounted remote access", "GET", `/api/bots/${botId}/novnc`),
    route("unmounted workspace management", "GET", "/api/workspaces"),
    route("unmounted workspace management", "POST", "/api/workspaces"),
    route("unmounted workspace management", "GET", `/api/bots/${botId}/workspace`),
    route("unmounted workspace management", "DELETE", `/api/bots/${botId}/workspace`),
  ];
}

function requestBody(method: Method): string | undefined {
  return method === "POST" || method === "PUT" || method === "PATCH" ? "{}" : undefined;
}

async function jsonRequest(
  base: string,
  testCase: Pick<DeniedRoute, "method" | "path">,
  headers: Record<string, string>,
) {
  const body = requestBody(testCase.method);
  const response = await fetch(`${base}${testCase.path}`, {
    method: testCase.method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers },
    body,
    redirect: "manual",
  });
  return { response, body: await response.json() as Record<string, unknown> };
}

function totalChanges(db: SqliteDatabase): number {
  return (db.prepare<{ count: number }>("SELECT total_changes() AS count").get()?.count ?? -1);
}

describe("SaaS route exposure matrix", () => {
  let home: string;
  let db: SqliteDatabase;
  let server: Server;
  let base: string;
  let app: Application;
  let sessionToken: string;
  let expiredSessionToken: string;
  let userId: string;
  let botId: string;
  let providerRegistry: ProviderRegistry;
  let computer: ComputerProvider;
  let reloadProviders: (() => Promise<void>) & MockInstance;
  let oauthAuthorizationUrl: GithubOAuthProvider["authorizationUrl"] & MockInstance;
  let oauthExchange: GithubOAuthProvider["exchangeCodeForIdentity"] & MockInstance;
  const sideEffectSpies: MockInstance[] = [];

  it("keeps the production route inventory synchronized with this exposure matrix", () => {
    const tokens = productionRouteTokens();
    expect(productionRouteInventoryDigest(tokens), tokens.join("\n")).toBe(PRODUCTION_ROUTE_INVENTORY_SHA256);
  });

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "velarix-saas-route-surface-"));
    db = openDatabase(join(home, "velarixbot.db"));
    const repos = createRepositories(db);
    const sessions = new IdentitySessions(db);
    const user = sessions.upsertGithubIdentity({ githubId: 36, login: "route-surface" }, NOW);
    userId = user.id;
    sessionToken = sessions.createSession(user.id, { now: NOW, maxAgeSeconds: 3_600 }).token;
    expiredSessionToken = sessions.createSession(user.id, { now: NOW - 10_000, maxAgeSeconds: 1 }).token;
    repos.userWorkspaceBindings.forOwner(user.id).record("box", "tenant-machine", NOW);

    const cfg: AppConfig = { box: { token: "local-fake-token" } };
    computer = await BoxComputerProviderFactory.create({ id: "box", config: {}, appConfig: cfg });
    const computers: ComputerRegistry = {
      get: (id) => id === "box" ? computer : null,
      list: () => [computer],
      resolveBinding: (value) => value === "box" || value === "cloud" ? "box" : "off",
      defaultRemote: () => computer,
    };
    providerRegistry = new ProviderRegistry([]);
    reloadProviders = vi.fn(async () => {});
    oauthAuthorizationUrl = vi.fn(({ state, codeChallenge }: { state: string; codeChallenge: string }) => {
      const url = new URL("https://github.com/login/oauth/authorize");
      url.searchParams.set("state", state);
      url.searchParams.set("code_challenge", codeChallenge);
      return url;
    });
    oauthExchange = vi.fn(async () => {
      throw new Error("OAuth exchange must remain local in this suite");
    });
    const oauthProvider: GithubOAuthProvider = {
      authorizationUrl: oauthAuthorizationUrl,
      exchangeCodeForIdentity: oauthExchange,
    };

    app = await createApplication({
      repos,
      providers: providerRegistry,
      computers,
      bus: new EventBus(),
      cfg,
      port: 0,
      apiToken: DESKTOP_TOKEN,
      auth: { mode: "saas", applicationOrigin: APPLICATION_ORIGIN, oauthProvider },
      commsToken: COMMS_TOKEN,
      staticDir: null,
      stamp: "saas-route-surface-test",
      clock: { now: () => NOW },
      reloadProviders,
      generateAvatarImages: async () => {
        throw new Error("avatar generation must not run");
      },
    });
    botId = app.services.bots.bots()[0].id;

    sideEffectSpies.push(
      vi.spyOn(providerRegistry, "get"),
      vi.spyOn(providerRegistry, "describe"),
      vi.spyOn(providerRegistry, "instances"),
      vi.spyOn(computer, "status").mockRejectedValue(new Error("computer status must not run")),
      vi.spyOn(computer, "provision").mockRejectedValue(new Error("computer provision must not run")),
      vi.spyOn(computer, "connectScreen").mockRejectedValue(new Error("computer join must not run")),
      vi.spyOn(computer, "suspend").mockRejectedValue(new Error("computer sleep must not run")),
      vi.spyOn(computer, "destroy").mockRejectedValue(new Error("computer destroy must not run")),
      vi.spyOn(computer, "screenshot").mockRejectedValue(new Error("computer screenshot must not run")),
      vi.spyOn(computer, "readFile").mockRejectedValue(new Error("computer file read must not run")),
      vi.spyOn(computer, "mcpIntegration").mockRejectedValue(new Error("computer MCP must not run")),
      vi.spyOn(computer, "execute").mockImplementation(async function* () {
        throw new Error("computer exec must not run");
      }),
      vi.spyOn(app.services.turns, "startTurn").mockRejectedValue(new Error("turn start must not run")),
      vi.spyOn(app.services.turns, "respond").mockRejectedValue(new Error("turn response must not run")),
      vi.spyOn(app.services.turns, "interrupt").mockRejectedValue(new Error("turn interrupt must not run")),
      vi.spyOn(app.services.turns, "askBotQueued").mockRejectedValue(new Error("COMMS ask must not run")),
      vi.spyOn(app.services.turns, "handleWorkspaceTool").mockRejectedValue(new Error("workspace tool must not run")),
      vi.spyOn(app.services.routines, "runRoutine").mockRejectedValue(new Error("routine run must not run")),
    );
    const maintenance = boxMaintenance(computer);
    if (!maintenance) throw new Error("test Box provider did not expose cleanup maintenance");
    sideEffectSpies.push(
      vi.spyOn(maintenance, "list").mockRejectedValue(new Error("cleanup list must not run")),
      vi.spyOn(maintenance, "destroy").mockRejectedValue(new Error("cleanup destroy must not run")),
      reloadProviders,
    );

    server = createServer((req, res) => void app.handle(req, res));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind TCP");
    base = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    if (server?.listening) {
      server.close();
      await once(server, "close");
    }
    db?.close();
    bestEffortRm(home);
  });

  it("returns public 404s for every authenticated unapproved route without non-audit side effects", async () => {
    const beforeChanges = totalChanges(db);
    const beforeAudit = db.prepare<{ n: number }>("SELECT count(*) AS n FROM event_log WHERE type = 'security.audit'").get()!.n;
    const headers = {
      cookie: `${SESSION_COOKIE_NAME}=${sessionToken}`,
      origin: APPLICATION_ORIGIN,
    };
    const cases = deniedRoutes(botId);
    for (const testCase of cases) {
      const result = await jsonRequest(base, testCase, headers);
      expect(result.response.status, `${testCase.family}: ${testCase.method} ${testCase.path}`).toBe(404);
      expect(result.body).toEqual({ error: expect.stringMatching(/^no route: /) });
    }
    const afterAudit = db.prepare<{ n: number }>("SELECT count(*) AS n FROM event_log WHERE type = 'security.audit'").get()!.n;
    expect(afterAudit - beforeAudit).toBe(cases.length);
    expect(totalChanges(db) - beforeChanges).toBe(afterAudit - beforeAudit);
    for (const spy of sideEffectSpies) expect(spy).not.toHaveBeenCalled();
    expect(oauthAuthorizationUrl).not.toHaveBeenCalled();
    expect(oauthExchange).not.toHaveBeenCalled();
  });

  it("uniformly rejects the matrix without a SaaS session or with a desktop bearer", async () => {
    const beforeChanges = totalChanges(db);
    const beforeAudit = db.prepare<{ n: number }>("SELECT count(*) AS n FROM event_log WHERE type = 'security.audit'").get()!.n;
    const cases = [
      ...deniedRoutes(botId),
      route("approved bot create", "POST", "/api/bots"),
      route("scoped desktop access", "GET", "/api/desktop-access"),
      route("scoped desktop access", "POST", "/api/desktop-access"),
      route("scoped desktop access", "DELETE", "/api/desktop-access"),
      route("scoped desktop viewer", "GET", "/api/desktop-access/view"),
    ];
    for (const testCase of cases) {
      const credentials: Record<string, string>[] = [
        { origin: APPLICATION_ORIGIN },
        { cookie: `${SESSION_COOKIE_NAME}=${expiredSessionToken}`, origin: APPLICATION_ORIGIN },
        { authorization: `Bearer ${DESKTOP_TOKEN}`, origin: APPLICATION_ORIGIN },
      ];
      for (const headers of credentials) {
        const result = await jsonRequest(base, testCase, headers);
        expect(result.response.status, `${testCase.family}: ${testCase.method} ${testCase.path}`).toBe(401);
        expect(result.body).toEqual({ error: "unauthorized" });
      }
    }
    const afterAudit = db.prepare<{ n: number }>("SELECT count(*) AS n FROM event_log WHERE type = 'security.audit'").get()!.n;
    // Each rejected credential resolution is now durably audited. Those
    // append-only rows are the only database changes in this adversarial matrix.
    expect(afterAudit - beforeAudit).toBe(cases.length * 3);
    expect(totalChanges(db) - beforeChanges).toBe(afterAudit - beforeAudit);
    for (const spy of sideEffectSpies) expect(spy).not.toHaveBeenCalled();
    expect(oauthAuthorizationUrl).not.toHaveBeenCalled();
    expect(oauthExchange).not.toHaveBeenCalled();
  });

  it("rejects missing or wrong Origin on every SaaS capability write without non-audit changes", async () => {
    const beforeChanges = totalChanges(db);
    const beforeAudit = db.prepare<{ n: number }>("SELECT count(*) AS n FROM event_log WHERE type = 'security.audit'").get()!.n;
    const cases = [
      { method: "POST" as const, path: "/api/bots" },
      { method: "POST" as const, path: "/api/desktop-access" },
      { method: "DELETE" as const, path: "/api/desktop-access" },
    ];
    const origins = [undefined, "https://evil.test"] as const;
    for (const testCase of cases) {
      for (const origin of origins) {
        const result = await jsonRequest(base, testCase, {
          cookie: `${SESSION_COOKIE_NAME}=${sessionToken}`,
          ...(origin ? { origin } : {}),
        });
        expect(result.response.status).toBe(403);
        expect(result.body).toEqual({ error: "forbidden origin" });
      }
    }
    const afterAudit = db.prepare<{ n: number }>("SELECT count(*) AS n FROM event_log WHERE type = 'security.audit'").get()!.n;
    expect(afterAudit - beforeAudit).toBe(cases.length * origins.length);
    expect(totalChanges(db) - beforeChanges).toBe(afterAudit - beforeAudit);
    for (const spy of sideEffectSpies) expect(spy).not.toHaveBeenCalled();
    expect(oauthAuthorizationUrl).not.toHaveBeenCalled();
    expect(oauthExchange).not.toHaveBeenCalled();
  });

  it("keeps internal COMMS inaccessible to both SaaS and desktop credentials", async () => {
    const beforeChanges = totalChanges(db);
    const probes: Array<Pick<DeniedRoute, "method" | "path">> = [
      { method: "GET", path: `/api/internal/agents?self=${botId}` },
      { method: "POST", path: "/api/internal/ask-bot" },
      { method: "POST", path: "/api/internal/delegate-bot" },
      { method: "POST", path: "/api/internal/create-bot" },
      { method: "POST", path: "/api/internal/delete-bot" },
      { method: "POST", path: "/api/internal/update-bot" },
      { method: "POST", path: "/api/internal/workspace" },
      { method: "POST", path: "/api/internal/remember" },
      { method: "POST", path: "/api/internal/recall" },
    ];
    for (const testCase of probes) {
      const credentials: Record<string, string>[] = [
        { cookie: `${SESSION_COOKIE_NAME}=${sessionToken}`, origin: APPLICATION_ORIGIN },
        { authorization: `Bearer ${DESKTOP_TOKEN}`, origin: APPLICATION_ORIGIN },
      ];
      for (const headers of credentials) {
        const result = await jsonRequest(base, testCase, headers);
        expect(result.response.status, `${testCase.method} ${testCase.path}`).toBe(401);
        expect(result.body).toEqual({ error: "unauthorized" });
      }
    }
    expect(totalChanges(db)).toBe(beforeChanges);
    for (const spy of sideEffectSpies) expect(spy).not.toHaveBeenCalled();
    expect(oauthAuthorizationUrl).not.toHaveBeenCalled();
    expect(oauthExchange).not.toHaveBeenCalled();
  });

  it("preserves only health, OAuth, session, catalog, and scoped desktop behavior", async () => {
    const health = await fetch(`${base}/api/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({
      app: "velarixbot",
      pid: process.pid,
      static: false,
      stamp: "saas-route-surface-test",
    });

    const start = await fetch(`${base}/api/auth/github/start`, { redirect: "manual" });
    expect(start.status).toBe(302);
    expect(new URL(start.headers.get("location")!).origin).toBe("https://github.com");
    expect(start.headers.get("set-cookie")).toContain("velarix_oauth_tx=");
    expect(oauthAuthorizationUrl).toHaveBeenCalledOnce();
    expect(oauthExchange).not.toHaveBeenCalled();

    const callback = await fetch(`${base}/api/auth/github/callback?code=unpaired`, { redirect: "manual" });
    expect(callback.status).toBe(303);
    expect(callback.headers.get("location")).toBe(`${APPLICATION_ORIGIN}/auth/result?outcome=callback_rejected`);
    expect(oauthExchange).not.toHaveBeenCalled();

    const authHeaders = { cookie: `${SESSION_COOKIE_NAME}=${sessionToken}` };
    const session = await fetch(`${base}/api/session`, { headers: authHeaders });
    expect(session.status).toBe(200);
    expect(await session.json()).toEqual({ user: { id: userId } });

    const catalog = await fetch(`${base}/api/bots`, { headers: authHeaders });
    expect(catalog.status).toBe(200);
    expect(await catalog.json()).toEqual({ bots: [] });

    const created = await fetch(`${base}/api/bots`, {
      method: "POST",
      headers: { ...authHeaders, origin: APPLICATION_ORIGIN, "content-type": "application/json" },
      body: "{}",
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json() as { bot: Record<string, unknown> };
    expect(Object.keys(createdBody)).toEqual(["bot"]);
    expect(Object.keys(createdBody.bot).sort()).toEqual(
      ["color", "description", "hasMore", "messages", "name", "publicHandle", "title"].sort(),
    );
    expect(createdBody.bot).toMatchObject({
      name: "New Bot",
      publicHandle: expect.any(String),
      messages: expect.any(Array),
    });
    for (const spy of sideEffectSpies) expect(spy).not.toHaveBeenCalled();

    const issued = await fetch(`${base}/api/desktop-access`, {
      method: "POST",
      headers: { ...authHeaders, origin: APPLICATION_ORIGIN, "content-type": "application/json" },
      body: "{}",
    });
    expect(issued.status).toBe(201);
    expect(await issued.json()).toEqual({ access: { expiresAt: NOW + 60_000 } });
    expect(issued.headers.get("set-cookie")).toMatch(
      /^velarix_desktop_access=[A-Za-z0-9_-]{43}; Path=\/api\/desktop-access; Max-Age=60; HttpOnly; Secure; SameSite=Strict$/,
    );
    const grantCookie = issued.headers.get("set-cookie")!.split(";", 1)[0];

    const access = await fetch(`${base}/api/desktop-access`, {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${sessionToken}; ${grantCookie}` },
    });
    expect(access.status).toBe(200);
    expect(await access.json()).toEqual({ access: { expiresAt: NOW + 60_000 } });

    const revoked = await fetch(`${base}/api/desktop-access`, {
      method: "DELETE",
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=${sessionToken}; ${grantCookie}`,
        origin: APPLICATION_ORIGIN,
      },
    });
    expect(revoked.status).toBe(204);
    expect(revoked.headers.get("set-cookie")).toContain("velarix_desktop_access=; ");

    const replay = await fetch(`${base}/api/desktop-access`, {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${sessionToken}; ${grantCookie}` },
    });
    expect(replay.status).toBe(410);
    expect(await replay.json()).toEqual({ error: "desktop access expired" });
    for (const spy of sideEffectSpies) expect(spy).not.toHaveBeenCalled();

    const signOut = await fetch(`${base}/api/auth/sign-out`, {
      method: "POST",
      headers: { origin: APPLICATION_ORIGIN },
    });
    expect(signOut.status).toBe(204);
    expect(signOut.headers.get("set-cookie")).toContain(`${SESSION_COOKIE_NAME}=; Max-Age=0`);
  });
});
