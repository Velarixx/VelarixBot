import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createApplication } from "./app.ts";
import type { ComputerRegistry } from "./computer/registry.ts";
import { openDatabase } from "./db/database.ts";
import type { SqliteDatabase } from "./db/sqlite-native.ts";
import { EventBus } from "./harness/bus.ts";
import { ProviderRegistry } from "./harness/registry.ts";
import { IdentitySessions, SESSION_COOKIE_NAME } from "./identity.ts";
import type { GithubOAuthProvider } from "./oauth/github-provider.ts";
import { createRepositories } from "./repositories/index.ts";
import { bestEffortRm } from "./testing/harness.ts";

const APPLICATION_ORIGIN = "https://audit.velarix.test";
const NOW = 1_900_000_000_000;
const PROVIDER_CANARY = "provider-private-audit-canary";
const MACHINE_CANARY = "machine-private-audit-canary";
const JOIN_URL_CANARY = "https://management.invalid/join?credential=private";

interface Fixture {
  base: string;
  db: SqliteDatabase;
  dbPath: string;
  home: string;
  server: Server;
  owner(id: number, bound: boolean): { id: string; session: string };
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
  async exchangeCodeForIdentity() {
    throw new Error("OAuth must not run in grant audit integration tests");
  },
};

async function fixture(failGrantAudit = false): Promise<Fixture> {
  const home = mkdtempSync(join(tmpdir(), "velarix-grant-audit-"));
  const dbPath = join(home, "velarixbot.db");
  const db = openDatabase(dbPath);
  const repos = createRepositories(db);
  const identities = new IdentitySessions(db);
  const originalAppend = repos.eventLog.appendToStream.bind(repos.eventLog);
  let app: Awaited<ReturnType<typeof createApplication>> | undefined;
  const server = createServer((req, res) => void app!.handle(req, res));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("grant audit test server did not bind");

  app = await createApplication({
    repos: failGrantAudit
      ? {
          ...repos,
          eventLog: {
            ...repos.eventLog,
            appendToStream(streamId, type, payload) {
              if (payload.action === "grant.issue") {
                throw new Error(`audit unavailable: ${JOIN_URL_CANARY}`);
              }
              return originalAppend(streamId, type, payload);
            },
          },
        }
      : repos,
    providers: new ProviderRegistry([]),
    computers,
    bus: new EventBus(),
    cfg: { computer: { providers: {} } },
    port: address.port,
    apiToken: "desktop-token-unused-in-saas",
    auth: { mode: "saas", applicationOrigin: APPLICATION_ORIGIN, oauthProvider },
    commsToken: "comms-token-unused-in-saas",
    staticDir: null,
    stamp: "grant-audit-integration",
    clock: { now: () => NOW },
    reloadProviders: async () => {},
  });

  const created: Fixture = {
    base: `http://127.0.0.1:${address.port}`,
    db,
    dbPath,
    home,
    server,
    owner(githubId, bound) {
      const user = identities.upsertGithubIdentity({ githubId, login: `audit-owner-${githubId}` }, NOW);
      if (bound) {
        repos.userWorkspaceBindings.forOwner(user.id).record(PROVIDER_CANARY, MACHINE_CANARY, NOW);
      }
      const session = identities.createSession(user.id, { now: NOW, maxAgeSeconds: 3_600 });
      return { id: user.id, session: session.token };
    },
  };
  fixtures.push(created);
  return created;
}

async function closeFixture(current: Fixture): Promise<void> {
  const index = fixtures.indexOf(current);
  if (index >= 0) fixtures.splice(index, 1);
  if (current.server.listening) {
    current.server.close();
    await once(current.server, "close");
  }
  current.db.close();
}

async function issue(current: Fixture, session: string): Promise<Response> {
  return fetch(`${current.base}/api/desktop-access`, {
    method: "POST",
    headers: {
      cookie: `${SESSION_COOKIE_NAME}=${session}`,
      origin: APPLICATION_ORIGIN,
      "content-type": "application/json",
    },
    body: "{}",
  });
}

function tenantStream(ownerId: string): string {
  return `security-audit:tenant:${createHash("sha256").update(ownerId, "utf8").digest("hex")}`;
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

describe("production SaaS desktop grant audit composition", () => {
  it("durably audits redacted unbound and quota denials without duplicate successes", async () => {
    const current = await fixture();
    const unbound = current.owner(801, false);
    const quota = current.owner(802, true);

    expect((await issue(current, unbound.session)).status).toBe(403);
    const first = await issue(current, quota.session);
    const second = await issue(current, quota.session);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect((await issue(current, quota.session)).status).toBe(403);
    const issuedTokens = [first, second].map((response) =>
      response.headers.get("set-cookie")!.match(/velarix_desktop_access=([^;]+)/)![1]!,
    );

    await closeFixture(current);
    const reopened = openDatabase(current.dbPath);
    try {
      const rows = reopened.prepare<{
        event_id: string;
        thread_id: string;
        type: string;
        data: string;
        stream_id: string;
      }>(
        "SELECT event_id, thread_id, type, data, stream_id FROM event_log WHERE type = 'security.audit' ORDER BY seq",
      ).all();
      const issueRows = rows
        .map((row) => ({ ...row, payload: JSON.parse(row.data) as Record<string, unknown> }))
        .filter((row) => row.payload.action === "grant.issue");

      expect(issueRows.filter((row) => row.stream_id === tenantStream(unbound.id)).map((row) => [
        row.payload.decision,
        row.payload.reason,
      ])).toEqual([["deny", "no_current_binding"]]);
      expect(issueRows.filter((row) => row.stream_id === tenantStream(quota.id)).map((row) => [
        row.payload.decision,
        row.payload.reason,
      ])).toEqual([
        ["allow", "issued"],
        ["allow", "issued"],
        ["deny", "quota"],
      ]);
      expect(issueRows.filter((row) => row.payload.decision === "allow")).toHaveLength(2);

      const durableLedger = JSON.stringify(rows);
      for (const forbidden of [
        unbound.id,
        quota.id,
        unbound.session,
        quota.session,
        ...issuedTokens,
        PROVIDER_CANARY,
        MACHINE_CANARY,
        JOIN_URL_CANARY,
      ]) {
        expect(durableLedger).not.toContain(forbidden);
      }
      expect(issueRows.every((row) => row.thread_id === row.stream_id)).toBe(true);
    } finally {
      reopened.close();
      bestEffortRm(current.home);
    }
  });

  it("fails closed without issuing or reporting success when grant audit writes fail", async () => {
    const current = await fixture(true);
    const unbound = current.owner(803, false);
    const bound = current.owner(804, true);

    for (const principal of [unbound, bound]) {
      const response = await issue(current, principal.session);
      const completeResponse = JSON.stringify({
        status: response.status,
        headers: Object.fromEntries(response.headers),
        body: await response.json(),
      });
      expect(response.status).toBe(500);
      expect(completeResponse).toContain("internal server error");
      expect(completeResponse).not.toContain("velarix_desktop_access");
      expect(completeResponse).not.toContain(JOIN_URL_CANARY);
    }

    expect(current.db.prepare<{ n: number }>(
      "SELECT count(*) AS n FROM desktop_access_grants",
    ).get()!.n).toBe(0);
    expect(current.db.prepare<{ n: number }>(
      "SELECT count(*) AS n FROM event_log WHERE type = 'security.audit' AND data LIKE '%\"action\":\"grant.issue\"%'",
    ).get()!.n).toBe(0);
  });
});
