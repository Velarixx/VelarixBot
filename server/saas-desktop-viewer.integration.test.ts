import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createApplication } from "./app.ts";
import type { ComputerProvider } from "./computer/provider.ts";
import { createComputerRegistry } from "./computer/registry.ts";
import type { AppConfig } from "./config.ts";
import { openDatabase } from "./db/database.ts";
import type { SqliteDatabase } from "./db/sqlite-native.ts";
import { EventBus } from "./harness/bus.ts";
import { ProviderRegistry } from "./harness/registry.ts";
import { IdentitySessions, SESSION_COOKIE_NAME } from "./identity.ts";
import type { GithubOAuthProvider } from "./oauth/github-provider.ts";
import { createRepositories, type Repositories } from "./repositories/index.ts";
import { SAAS_DESKTOP_ACCESS_COOKIE } from "./routes/saas-desktop-access.ts";

const APPLICATION_ORIGIN = "https://viewer.velarix.test";
const DESKTOP_TOKEN = "desktop-mode-token-unused-by-saas";
const COMMS_TOKEN = "internal-comms-token";

interface TestContext {
  db: SqliteDatabase;
  dbDir: string;
  dbPath: string;
  repos: Repositories;
  server: Server;
  base: string;
  now: number;
  setNow(value: number): void;
  ownerId: string;
  foreignOwnerId: string;
  ownerSession: string;
  foreignSession: string;
  provider: ComputerProvider;
  machineId: string;
}

function sessionCookie(token: string): string {
  return `${SESSION_COOKIE_NAME}=${token}`;
}

function grantCookie(setCookie: string): string {
  return setCookie.split(";", 1)[0]!;
}

async function issue(ctx: TestContext, session = ctx.ownerSession): Promise<string> {
  const response = await fetch(`${ctx.base}/api/desktop-access`, {
    method: "POST",
    headers: {
      cookie: sessionCookie(session),
      origin: APPLICATION_ORIGIN,
      "content-type": "application/json",
    },
    body: "{}",
  });
  expect(response.status).toBe(201);
  return grantCookie(response.headers.get("set-cookie")!);
}

async function revoke(ctx: TestContext, cookie: string): Promise<Response> {
  return fetch(`${ctx.base}/api/desktop-access`, {
    method: "DELETE",
    headers: {
      cookie: `${sessionCookie(ctx.ownerSession)}; ${cookie}`,
      origin: APPLICATION_ORIGIN,
    },
  });
}

async function viewerOutcome(ctx: TestContext, session: string, cookie: string) {
  const response = await fetch(`${ctx.base}/api/desktop-access/view`, {
    headers: { cookie: `${sessionCookie(session)}; ${cookie}` },
  });
  return {
    status: response.status,
    body: await response.json(),
    contentType: response.headers.get("content-type"),
    cacheControl: response.headers.get("cache-control"),
  };
}

async function boot(): Promise<TestContext> {
  const dbDir = mkdtempSync(join(tmpdir(), "velarix-viewer-"));
  const dbPath = join(dbDir, "viewer.sqlite");
  const db = openDatabase(dbPath);
  const repos = createRepositories(db);
  let now = 1_900_000_000_000;
  const identities = new IdentitySessions(db);
  const owner = identities.upsertGithubIdentity({ githubId: 901, login: "viewer-owner" }, now);
  const foreign = identities.upsertGithubIdentity({ githubId: 902, login: "viewer-foreign" }, now);
  const ownerSession = identities.createSession(owner.id, { now, maxAgeSeconds: 3_600 }).token;
  const foreignSession = identities.createSession(foreign.id, { now, maxAgeSeconds: 3_600 }).token;

  const cfg: AppConfig = { computer: { providers: { fake: { kind: "fake" } } } };
  const computers = await createComputerRegistry({ cfg });
  const provider = computers.get("fake")!;
  const provisioned = await provider.provision({ id: "tenant-viewer", name: "Tenant viewer" });
  repos.userWorkspaceBindings.forOwner(owner.id).record(provider.kind, provisioned.machineId, now);
  const oauthProvider: GithubOAuthProvider = {
    authorizationUrl() { throw new Error("OAuth must not run in viewer integration"); },
    async exchangeCodeForIdentity() { throw new Error("OAuth must not run in viewer integration"); },
  };

  const app = await createApplication({
    repos,
    providers: new ProviderRegistry([]),
    computers,
    bus: new EventBus(),
    cfg,
    port: 0,
    apiToken: DESKTOP_TOKEN,
    auth: { mode: "saas", applicationOrigin: APPLICATION_ORIGIN, oauthProvider },
    commsToken: COMMS_TOKEN,
    staticDir: null,
    stamp: "desktop-viewer-integration",
    clock: { now: () => now },
    reloadProviders: async () => {},
  });
  const server = createServer((req, res) => void app.handle(req, res));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("viewer test server did not bind");
  return {
    db,
    dbDir,
    dbPath,
    repos,
    server,
    base: `http://127.0.0.1:${address.port}`,
    get now() { return now; },
    setNow(value) { now = value; },
    ownerId: owner.id,
    foreignOwnerId: foreign.id,
    ownerSession,
    foreignSession,
    provider,
    machineId: provisioned.machineId,
  };
}

describe("same-origin SaaS desktop viewer broker", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await boot();
  });

  afterEach(async () => {
    if (ctx?.server.listening) {
      ctx.server.close();
      ctx.server.closeAllConnections();
      await once(ctx.server, "close");
    }
    ctx?.db.close();
    if (ctx?.dbDir) rmSync(ctx.dbDir, { recursive: true, force: true });
  });

  it("renders the bound fake machine as a same-origin image stream and revocation closes it", async () => {
    const rawJoin = vi.spyOn(ctx.provider, "connectScreen");
    const cookie = await issue(ctx);
    const response = await fetch(`${ctx.base}/api/desktop-access/view`, {
      headers: { cookie: `${sessionCookie(ctx.ownerSession)}; ${cookie}` },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("multipart/x-mixed-replace; boundary=velarix-desktop-frame");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");

    const reader = response.body!.getReader();
    const chunks: Uint8Array[] = [];
    const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    let rendered = Buffer.alloc(0);
    for (let attempt = 0; attempt < 5 && !rendered.includes(pngSignature); attempt += 1) {
      const next = await reader.read();
      expect(next.done).toBe(false);
      chunks.push(next.value);
      rendered = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
    }
    expect(rendered.includes(pngSignature)).toBe(true);
    expect(rendered.toString("latin1")).not.toMatch(/fake:\/\/|tenant-viewer|fake-tenant-viewer|token|credential/i);
    expect(rawJoin).not.toHaveBeenCalled();

    expect((await revoke(ctx, cookie)).status).toBe(204);
    let closed = false;
    while (!closed) {
      const next = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("revoked viewer stayed open")), 1_000)),
      ]);
      closed = next.done;
    }
    expect(await viewerOutcome(ctx, ctx.ownerSession, cookie)).toEqual({
      status: 404,
      body: { error: "desktop viewer unavailable" },
      contentType: "application/json",
      cacheControl: "private, no-store",
    });
  });

  it("collapses malformed, foreign, revoked, expired, stale/ABA, and scope mismatch to one response", async () => {
    const foreignToken = await issue(ctx);
    const foreign = viewerOutcome(ctx, ctx.foreignSession, foreignToken);
    await revoke(ctx, foreignToken);

    const revokedToken = await issue(ctx);
    await revoke(ctx, revokedToken);

    const expiredToken = await issue(ctx);
    ctx.setNow(ctx.now + 60_000);

    const staleToken = await issue(ctx);
    ctx.repos.userWorkspaceBindings.forOwner(ctx.ownerId).record("fake", "temporary-machine", ctx.now);
    ctx.repos.userWorkspaceBindings.forOwner(ctx.ownerId).record("fake", ctx.machineId, ctx.now);

    const originalOpen = ctx.provider.openViewer!.bind(ctx.provider);
    let releaseOpen!: () => void;
    let markEntered!: () => void;
    const enteredOpen = new Promise<void>((resolve) => { markEntered = resolve; });
    const openGate = new Promise<void>((resolve) => { releaseOpen = resolve; });
    ctx.provider.openViewer = async (machineId, options) => {
      markEntered();
      await openGate;
      return originalOpen(machineId, options);
    };
    const handshakeToken = await issue(ctx);
    const handshakeAba = viewerOutcome(ctx, ctx.ownerSession, handshakeToken);
    await enteredOpen;
    ctx.repos.userWorkspaceBindings.forOwner(ctx.ownerId).record("fake", "handshake-machine", ctx.now);
    ctx.repos.userWorkspaceBindings.forOwner(ctx.ownerId).record("fake", ctx.machineId, ctx.now);
    releaseOpen();

    const control = ctx.repos.desktopAccessGrants.forOwner(ctx.ownerId)!.mint(
      { providerKind: "fake", machineId: ctx.machineId },
      "desktop:control",
      { now: ctx.now, ttlMs: 60_000 },
    )!;
    const outcomes = await Promise.all([
      viewerOutcome(ctx, ctx.ownerSession, `${SAAS_DESKTOP_ACCESS_COOKIE}=malformed`),
      foreign,
      viewerOutcome(ctx, ctx.ownerSession, revokedToken),
      viewerOutcome(ctx, ctx.ownerSession, expiredToken),
      viewerOutcome(ctx, ctx.ownerSession, staleToken),
      handshakeAba,
      viewerOutcome(ctx, ctx.ownerSession, `${SAAS_DESKTOP_ACCESS_COOKIE}=${control.token}`),
    ]);
    expect(new Set(outcomes.map((outcome) => JSON.stringify(outcome)))).toEqual(new Set([
      JSON.stringify({
        status: 404,
        body: { error: "desktop viewer unavailable" },
        contentType: "application/json",
        cacheControl: "private, no-store",
      }),
    ]));
  });

  it("bounds and redacts provider failure and timeout without falling back to a join URL", async () => {
    const rawJoin = vi.spyOn(ctx.provider, "connectScreen");
    const failedToken = await issue(ctx);
    ctx.provider.openViewer = async () => {
      throw new Error("https://provider.invalid/join?token=raw-secret machine=provider-machine");
    };
    const failed = await viewerOutcome(ctx, ctx.ownerSession, failedToken);
    expect(failed).toMatchObject({ status: 503, body: { error: "desktop viewer unavailable" } });
    expect(JSON.stringify(failed)).not.toMatch(/provider\.invalid|raw-secret|provider-machine|join\?token/i);
    await revoke(ctx, failedToken);

    const timedToken = await issue(ctx);
    ctx.provider.openViewer = () => new Promise(() => {});
    const started = Date.now();
    const timed = await viewerOutcome(ctx, ctx.ownerSession, timedToken);
    expect(timed).toMatchObject({ status: 503, body: { error: "desktop viewer unavailable" } });
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(rawJoin).not.toHaveBeenCalled();
  }, 10_000);

  it("closes a live provider within the monitor bound after cross-instance durable revocation", async () => {
    const originalOpen = ctx.provider.openViewer!.bind(ctx.provider);
    let providerSignal: AbortSignal | undefined;
    ctx.provider.openViewer = async (machineId, options) => {
      providerSignal = options.signal;
      return originalOpen(machineId, options);
    };
    const cookie = await issue(ctx);
    const response = await fetch(`${ctx.base}/api/desktop-access/view`, {
      headers: { cookie: `${sessionCookie(ctx.ownerSession)}; ${cookie}` },
    });
    const reader = response.body!.getReader();
    expect((await reader.read()).done).toBe(false);

    const secondDb = openDatabase(ctx.dbPath);
    try {
      const secondRepos = createRepositories(secondDb);
      const token = cookie.slice(cookie.indexOf("=") + 1);
      expect(secondRepos.desktopAccessGrants.forOwner(ctx.ownerId)!.revoke(
        token,
        { providerKind: "fake", machineId: ctx.machineId },
        "desktop:view",
        ctx.now,
      )).toBe(true);
      await expect(Promise.race([
        (async () => {
          while (!(await reader.read()).done) { /* drain until authorization closes the stream */ }
          return "closed";
        })(),
        new Promise((resolve) => setTimeout(() => resolve("open"), 1_000)),
      ])).resolves.toBe("closed");
      expect(providerSignal?.aborted).toBe(true);
    } finally {
      secondDb.close();
    }
  });

  it("does not release a pending old-machine frame after a generation ABA", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let providerSignal: AbortSignal | undefined;
    ctx.provider.openViewer = async (_machineId, options) => {
      providerSignal = options.signal;
      return {
        initialFrame: { width: 1, height: 1, rgba: new Uint8Array([1, 2, 3, 255]) },
        frames: (async function* () {
          await gate;
          yield { width: 1, height: 1, rgba: new Uint8Array([4, 5, 6, 255]) };
        })(),
      };
    };
    const cookie = await issue(ctx);
    const response = await fetch(`${ctx.base}/api/desktop-access/view`, {
      headers: { cookie: `${sessionCookie(ctx.ownerSession)}; ${cookie}` },
    });
    const reader = response.body!.getReader();
    const received: Buffer[] = [];
    received.push(Buffer.from((await reader.read()).value!));
    ctx.repos.userWorkspaceBindings.forOwner(ctx.ownerId).record("fake", "temporary-machine", ctx.now);
    ctx.repos.userWorkspaceBindings.forOwner(ctx.ownerId).record("fake", ctx.machineId, ctx.now);
    release();
    await expect(Promise.race([
      (async () => {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          received.push(Buffer.from(next.value));
        }
        return "closed";
      })(),
      new Promise((resolve) => setTimeout(() => resolve("open"), 1_000)),
    ])).resolves.toBe("closed");
    const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const allReceived = Buffer.concat(received);
    let pngCount = 0;
    for (let offset = 0; offset <= allReceived.length - pngSignature.length; offset += 1) {
      if (allReceived.subarray(offset, offset + pngSignature.length).equals(pngSignature)) pngCount += 1;
    }
    expect(pngCount).toBe(2);
    expect(providerSignal?.aborted).toBe(true);
  });

  it("canonicalizes exact-size pixels and rejects malformed frame bounds without disclosure", async () => {
    const injected = Buffer.from("https://provider.invalid/join?token=raw-secret machine=provider-machine\\r\\n--velarix-desktop-frame");
    const padded = Buffer.alloc(Math.ceil(injected.length / 4) * 4);
    injected.copy(padded);
    ctx.provider.openViewer = async (_machineId, { signal }) => ({
      initialFrame: { width: padded.length / 4, height: 1, rgba: padded },
      frames: (async function* () {
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      })(),
    });
    const cookie = await issue(ctx);
    const response = await fetch(`${ctx.base}/api/desktop-access/view`, {
      headers: { cookie: `${sessionCookie(ctx.ownerSession)}; ${cookie}` },
    });
    const reader = response.body!.getReader();
    const first = Buffer.from((await reader.read()).value!);
    await revoke(ctx, cookie);
    const rest: Buffer[] = [];
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      rest.push(Buffer.from(next.value));
    }
    const browserBytes = Buffer.concat([first, ...rest]);
    expect(browserBytes.includes(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))).toBe(true);
    expect(browserBytes.toString("latin1")).not.toMatch(/provider\.invalid|raw-secret|provider-machine|join\?token/i);
    expect(browserBytes.toString("latin1").match(/--velarix-desktop-frame/g)).toHaveLength(2);

    for (const invalid of [
      { width: 0, height: 1, rgba: new Uint8Array() },
      { width: 1_921, height: 1, rgba: new Uint8Array(1_921 * 4) },
      { width: 1, height: 1_081, rgba: new Uint8Array(1_081 * 4) },
      { width: 2, height: 1, rgba: new Uint8Array(7) },
    ]) {
      ctx.provider.openViewer = async () => ({ initialFrame: invalid, frames: (async function* () {})() });
      const invalidCookie = await issue(ctx);
      const outcome = await viewerOutcome(ctx, ctx.ownerSession, invalidCookie);
      expect(outcome).toMatchObject({ status: 503, body: { error: "desktop viewer unavailable" } });
      expect(JSON.stringify(outcome)).not.toMatch(/width|height|rgba|provider|machine/i);
      await revoke(ctx, invalidCookie);
    }
  });
});
