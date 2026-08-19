import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createApplication, type Application } from "./app.ts";
import type { ComputerRegistry } from "./computer/registry.ts";
import { openDatabase } from "./db/database.ts";
import type { SqliteDatabase, SqliteStatement } from "./db/sqlite-native.ts";
import { EventBus } from "./harness/bus.ts";
import { ProviderRegistry } from "./harness/registry.ts";
import { IdentitySessions, SESSION_COOKIE_NAME } from "./identity.ts";
import type { GithubOAuthProvider } from "./oauth/github-provider.ts";
import { createRepositories } from "./repositories/index.ts";
import { bestEffortRm } from "./testing/harness.ts";

const APPLICATION_ORIGIN = "https://app.velarix.test";
const DESKTOP_TOKEN = "app-boundary-desktop-token";
const NOW = 1_800_000_000_000;
const CANARY_SECRET = "oauth_token=canary-super-secret";
const CANARY_PATH = "C:\\tenant-private\\velarix.db";
const CANARY_MESSAGE = `${CANARY_SECRET} at ${CANARY_PATH} for provider machine-private-42`;

interface Fixture {
  app: Application;
  base: string;
  db: SqliteDatabase;
  home: string;
  server: Server;
  sessionToken?: string;
}

const fixtures: Fixture[] = [];

const computers: ComputerRegistry = {
  get: () => null,
  list: () => [],
  resolveBinding: (value) => value === "off" ? "off" : null,
  defaultRemote: () => null,
};

const oauthProvider: GithubOAuthProvider = {
  authorizationUrl: () => new URL("https://github.com/login/oauth/authorize"),
  exchangeCodeForIdentity: async () => {
    throw new Error("OAuth exchange must not run in app boundary tests");
  },
};

async function fixture(mode: "saas" | "desktop"): Promise<Fixture> {
  const home = mkdtempSync(join(tmpdir(), "velarix-app-boundary-"));
  const db = openDatabase(join(home, "velarixbot.db"));
  const repos = createRepositories(db);
  let sessionToken: string | undefined;
  if (mode === "saas") {
    const sessions = new IdentitySessions(db);
    const user = sessions.upsertGithubIdentity({ githubId: 46, login: "app-boundary" }, NOW);
    sessionToken = sessions.createSession(user.id, { now: NOW, maxAgeSeconds: 3_600 }).token;
  }

  let app: Application | undefined;
  const server = createServer((req, res) => void app!.handle(req, res));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind TCP");

  app = await createApplication({
    repos,
    providers: new ProviderRegistry([]),
    computers,
    bus: new EventBus(),
    cfg: { computer: { providers: {} } },
    port: address.port,
    apiToken: DESKTOP_TOKEN,
    ...(mode === "saas"
      ? { auth: { mode: "saas" as const, applicationOrigin: APPLICATION_ORIGIN, oauthProvider } }
      : { auth: { mode: "desktop" as const } }),
    commsToken: "app-boundary-comms-token",
    staticDir: null,
    stamp: "app-boundary-test",
    clock: { now: () => NOW },
    reloadProviders: async () => {},
  });
  const created = { app, base: `http://127.0.0.1:${address.port}`, db, home, server, sessionToken };
  fixtures.push(created);
  return created;
}

afterEach(async () => {
  for (const current of fixtures.splice(0)) {
    if (current.server.listening) {
      current.server.close();
      await once(current.server, "close");
    }
    current.db.close();
    bestEffortRm(current.home);
  }
});

describe("application error boundary", () => {
  it("fails closed when authenticated SaaS session lookup throws sensitive detail", async () => {
    const current = await fixture("saas");
    const originalPrepare: SqliteDatabase["prepare"] = current.db.prepare.bind(current.db);
    current.db.prepare = function prepare<Row = unknown>(sql: string): SqliteStatement<Row> {
      if (sql.includes("FROM sessions s")) throw new Error(CANARY_MESSAGE);
      return originalPrepare<Row>(sql);
    };

    const response = await fetch(`${current.base}/api/session`, {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${current.sessionToken}` },
    });
    const body = await response.text();
    const completeResponse = JSON.stringify({
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body,
    });

    expect(response.status).toBe(500);
    expect(JSON.parse(body)).toEqual({ error: "internal server error" });
    expect(completeResponse).not.toContain(CANARY_SECRET);
    expect(completeResponse).not.toContain(CANARY_PATH);
    expect(completeResponse).not.toContain("machine-private-42");
  });

  it("preserves a deliberate bounded SaaS malformed-request response", async () => {
    const current = await fixture("saas");
    const response = await fetch(`${current.base}/api/bots?messages=not-a-number`, {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${current.sessionToken}` },
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "messages must be one non-negative whole number",
    });
  });

  it("preserves loopback desktop status and diagnostic detail", async () => {
    const current = await fixture("desktop");
    vi.spyOn(current.app.services.bots, "publicBots").mockImplementation(() => {
      throw Object.assign(new Error(CANARY_MESSAGE), { status: 409 });
    });
    const response = await fetch(`${current.base}/api/bots`, {
      headers: { authorization: `Bearer ${DESKTOP_TOKEN}` },
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: CANARY_MESSAGE });
  });
});
