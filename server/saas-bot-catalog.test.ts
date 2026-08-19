import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { openDatabase } from "./db/database.ts";
import { IdentitySessions, SESSION_COOKIE_NAME } from "./identity.ts";
import { createRepositories } from "./repositories/index.ts";
import { createBotsService } from "./services/bots.ts";
import {
  bestEffortRm,
  harnessEnv,
  SERVER_ENTRY,
  stopChild,
  TESTING_DIR,
  waitForHealth,
  writeHarnessConfig,
} from "./testing/harness.ts";

const applicationOrigin = "https://app.velarix.test";
const selection = () => ({ instanceId: "claude", model: "claude-sonnet-5" });

interface SeededHome {
  home: string;
  tokenA: string;
  tokenB: string;
  botAId: string;
  botBId: string;
  legacyId: string;
}

function seedHome(prefix: string): SeededHome {
  const home = mkdtempSync(join(tmpdir(), prefix));
  writeHarnessConfig(home, {});
  const db = openDatabase(join(home, ".velarixbot", "velarixbot.db"));
  const identity = new IdentitySessions(db);
  const now = Date.now();
  const userA = identity.upsertGithubIdentity({ githubId: 3301, login: "app-catalog-a" }, now);
  const userB = identity.upsertGithubIdentity({ githubId: 3302, login: "app-catalog-b" }, now);
  const tokenA = identity.createSession(userA.id, { now, maxAgeSeconds: 3_600 }).token;
  const tokenB = identity.createSession(userB.id, { now, maxAgeSeconds: 3_600 }).token;
  const bots = createBotsService({ repos: createRepositories(db), defaultSelection: selection });
  const legacy = bots.createBot();
  bots.patchBot(legacy.id, { name: "Legacy Global" });
  const botA = bots.forOwner(userA.id).createBot();
  bots.forOwner(userA.id).patchBot(botA.id, { name: "Alpha SaaS" });
  const botB = bots.forOwner(userB.id).createBot();
  bots.forOwner(userB.id).patchBot(botB.id, { name: "Beta SaaS" });
  db.close();
  return { home, tokenA, tokenB, botAId: botA.id, botBId: botB.id, legacyId: legacy.id };
}

function startServer(home: string, mode: "saas" | "desktop", token: string) {
  const port = 30_000 + Math.floor(Math.random() * 2_000);
  const base = `http://127.0.0.1:${port}`;
  let stderr = "";
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: join(TESTING_DIR, "..", ".."),
    env: harnessEnv(home, {
      OMB_PORT: String(port),
      OMB_COMMS_TOKEN: "catalog-comms-token",
      VELARIX_DEV_TOKEN: token,
      VELARIX_AUTH_MODE: mode,
      ...(mode === "saas"
        ? {
            VELARIX_APP_ORIGIN: applicationOrigin,
            VELARIX_GITHUB_CLIENT_ID: "catalog-client-id",
            VELARIX_GITHUB_CLIENT_SECRET: "catalog-client-secret",
            VELARIX_GITHUB_CALLBACK_URL: `${applicationOrigin}/api/auth/github/callback`,
          }
        : {}),
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr!.on("data", (chunk) => (stderr += chunk));
  return { base, child, stderr: () => stderr };
}

function sessionHeaders(token: string): Record<string, string> {
  return { cookie: `${SESSION_COOKIE_NAME}=${token}` };
}

async function responseJson(base: string, path: string, headers: Record<string, string> = {}) {
  const response = await fetch(`${base}${path}`, { headers });
  return { response, body: await response.json() as any };
}

describe("SaaS bot catalog application composition", () => {
  let seeded: SeededHome;
  let child: ChildProcess;
  let base: string;

  beforeAll(async () => {
    seeded = seedHome("velarix-saas-bot-catalog-");
    const server = startServer(seeded.home, "saas", "unused-desktop-token");
    child = server.child;
    base = server.base;
    await waitForHealth(base, child, server.stderr);
  }, 30_000);

  afterAll(async () => {
    await stopChild(child);
    bestEffortRm(seeded.home);
  });

  it("requires a server-side session and isolates the catalog for both users", async () => {
    const anonymous = await responseJson(base, "/api/bots");
    expect(anonymous.response.status).toBe(401);
    expect(anonymous.body).toEqual({ error: "unauthorized" });

    const a = await responseJson(base, "/api/bots", sessionHeaders(seeded.tokenA));
    const b = await responseJson(base, "/api/bots", sessionHeaders(seeded.tokenB));
    expect(a.response.status).toBe(200);
    expect(a.body.bots.map((bot: { name: string }) => bot.name)).toEqual(["Alpha SaaS"]);
    expect(b.body.bots.map((bot: { name: string }) => bot.name)).toEqual(["Beta SaaS"]);

    const serialized = JSON.stringify([a.body, b.body]);
    for (const internalId of [seeded.botAId, seeded.botBId, seeded.legacyId]) {
      expect(serialized).not.toContain(internalId);
    }
    expect(serialized).not.toContain("Legacy Global");
  });

  it("keeps unrelated SaaS product and shell paths unmounted", async () => {
    for (const path of [
      `/api/bots/${seeded.botAId}`,
      "/api/events",
      "/api/routines",
      "/api/computers",
      "/api/approvals",
    ]) {
      const result = await responseJson(base, path, sessionHeaders(seeded.tokenA));
      expect(result.response.status, path).toBe(404);
    }
    const shell = await fetch(`${base}/`);
    expect(shell.status).toBe(404);
  });
});

describe("desktop bot route compatibility", () => {
  it("keeps GET /api/bots process-global and protected by the launch token", async () => {
    const seeded = seedHome("velarix-desktop-bot-catalog-");
    const launchToken = "desktop-catalog-launch-token";
    const server = startServer(seeded.home, "desktop", launchToken);
    try {
      await waitForHealth(server.base, server.child, server.stderr);
      const denied = await responseJson(server.base, "/api/bots");
      expect(denied.response.status).toBe(401);
      expect(denied.body).toEqual({ error: "unauthorized" });

      const allowed = await responseJson(server.base, "/api/bots", {
        authorization: `Bearer ${launchToken}`,
      });
      expect(allowed.response.status).toBe(200);
      expect(allowed.body.bots.map((bot: { name: string }) => bot.name).sort()).toEqual(
        ["Alpha SaaS", "Beta SaaS", "Legacy Global"].sort(),
      );
      expect(allowed.body.bots.map((bot: { id: string }) => bot.id)).toEqual(
        expect.arrayContaining([seeded.botAId, seeded.botBId, seeded.legacyId]),
      );
    } finally {
      await stopChild(server.child);
      bestEffortRm(seeded.home);
    }
  }, 30_000);
});
