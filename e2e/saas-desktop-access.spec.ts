import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test, type Browser, type BrowserContext, type Page, type Route } from "playwright/test";

import { createApplication } from "../server/app.ts";
import { createComputerRegistry } from "../server/computer/registry.ts";
import type { AppConfig } from "../server/config.ts";
import { openDatabase } from "../server/db/database.ts";
import { EventBus } from "../server/harness/bus.ts";
import { ProviderRegistry } from "../server/harness/registry.ts";
import { IdentitySessions, SESSION_COOKIE_NAME } from "../server/identity.ts";
import type { GithubOAuthProvider } from "../server/oauth/github-provider.ts";
import { createRepositories } from "../server/repositories/index.ts";
import { SAAS_DESKTOP_ACCESS_COOKIE } from "../server/routes/saas-desktop-access.ts";
import { bootHarness, type BootedHarness } from "../server/testing/harness.ts";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const VITE_CLI = join(REPO, "node_modules", "vite", "bin", "vite.js");
const AXE_PATH = createRequire(import.meta.url).resolve("axe-core/axe.min.js");
const RAW_DETAIL = "raw-provider-machine-token-secret-must-not-render";
const DESKTOP_PATH = "/api/desktop-access";
const CATALOG = {
  bots: [{
    name: "Planner",
    title: "Planning assistant",
    description: "Builds reviewable plans.",
    color: "green",
    messages: [],
    hasMore: false,
  }],
};

interface DesktopCounts { check: number; request: number; revoke: number }
interface DesktopOptions {
  desktop(route: Route, method: "GET" | "POST" | "DELETE", requestNumber: number): Promise<void> | void;
}

function buildSaasClient(): void {
  execFileSync(process.execPath, [VITE_CLI, "build", "--logLevel", "warn"], {
    cwd: REPO,
    env: { ...process.env, VITE_VELARIX_APP_MODE: "saas" },
    stdio: "pipe",
  });
}

async function json(route: Route, status: number, body: unknown): Promise<void> {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function openSaas(browser: Browser, options: DesktopOptions): Promise<{
  context: BrowserContext;
  counts: DesktopCounts;
  harness: BootedHarness;
  page: Page;
}> {
  const harness = await bootHarness({ instances: {}, env: { OMB_STATIC_DIR: join(REPO, "dist") } });
  const context = await browser.newContext({ extraHTTPHeaders: { authorization: `Bearer ${harness.token}` } });
  const counts: DesktopCounts = { check: 0, request: 0, revoke: 0 };
  await context.route(`${harness.base}/api/session`, (route) => json(route, 200, {
    user: { id: "123e4567-e89b-42d3-a456-426614174000" },
  }));
  await context.route(`${harness.base}/api/bots?messages=0`, (route) => json(route, 200, CATALOG));
  await context.route(`${harness.base}${DESKTOP_PATH}`, async (route) => {
    const method = route.request().method() as "GET" | "POST" | "DELETE";
    const key = method === "GET" ? "check" : method === "POST" ? "request" : "revoke";
    counts[key] += 1;
    await options.desktop(route, method, counts[key]);
  });
  const page = await context.newPage();
  await page.goto(harness.base, { waitUntil: "domcontentloaded" });
  return { context, counts, harness, page };
}

async function closeSaas(context: BrowserContext, harness: BootedHarness): Promise<void> {
  await context.close();
  await harness.stop();
}

async function axeScan(page: Page, label: string): Promise<void> {
  if (!await page.evaluate(() => Boolean((window as typeof window & { axe?: unknown }).axe))) {
    await page.addScriptTag({ path: AXE_PATH });
  }
  const violations = await page.evaluate(async () => {
    const axe = (window as typeof window & {
      axe: { run(context: { exclude: string[][] }, options: unknown): Promise<{ violations: unknown[] }> };
    }).axe;
    const result = await axe.run(
      // The independently owned DHV-63 fix removes this temporary exclusion.
      { exclude: [[".bg-accent"]] },
      { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] } },
    );
    return result.violations;
  });
  expect(violations, `${label} axe violations:\n${JSON.stringify(violations, null, 2)}`).toEqual([]);
}

async function expectRedacted(page: Page): Promise<void> {
  await expect(page.getByText(RAW_DETAIL, { exact: false })).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText(/accessToken|joinUrl|providerKind|machineId|VNC|SSH/i);
}

function deferred(): { promise: Promise<void>; release(): void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

test.describe.serial("scoped SaaS remote desktop access", () => {
  test.beforeAll(() => buildSaasClient());

  test("renders the real fake-provider broker and closes it on revocation", async ({ browser }) => {
    const db = openDatabase(":memory:");
    const repos = createRepositories(db);
    const identities = new IdentitySessions(db);
    const owner = identities.upsertGithubIdentity({ githubId: 8_101, login: "browser-viewer" }, Date.now());
    const session = identities.createSession(owner.id, { now: Date.now(), maxAgeSeconds: 3_600 });
    const cfg: AppConfig = { computer: { providers: { fake: { kind: "fake" } } } };
    const computers = await createComputerRegistry({ cfg });
    const provider = computers.get("fake")!;
    const provisioned = await provider.provision({ id: "browser-tenant", name: "Browser tenant" });
    repos.userWorkspaceBindings.forOwner(owner.id).record(provider.kind, provisioned.machineId, Date.now());
    const grant = repos.desktopAccessGrants.forOwner(owner.id)!.mint(
      { providerKind: provider.kind, machineId: provisioned.machineId },
      "desktop:view",
      { now: Date.now(), ttlMs: 60_000 },
    )!;
    const originalOpen = provider.openViewer!.bind(provider);
    let providerSignal: AbortSignal | undefined;
    provider.openViewer = async (machineId, options) => {
      providerSignal = options.signal;
      return originalOpen(machineId, options);
    };
    const oauthProvider: GithubOAuthProvider = {
      authorizationUrl() { throw new Error("OAuth must not run in viewer browser coverage"); },
      async exchangeCodeForIdentity() { throw new Error("OAuth must not run in viewer browser coverage"); },
    };
    let handler: (req: IncomingMessage, res: ServerResponse) => void = (_req, res) => { res.end(); };
    const server = createServer((req, res) => void handler(req, res));
    server.listen(0, "localhost");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("viewer browser server did not bind");
    const base = `http://localhost:${address.port}`;
    const applicationOrigin = "https://viewer.velarix.test";
    const app = await createApplication({
      repos,
      providers: new ProviderRegistry([]),
      computers,
      bus: new EventBus(),
      cfg,
      port: address.port,
      apiToken: "desktop-token-unused-by-saas",
      auth: { mode: "saas", applicationOrigin, oauthProvider },
      commsToken: "browser-comms-token",
      staticDir: join(REPO, "dist"),
      stamp: "desktop-viewer-browser",
      reloadProviders: async () => {},
    });
    handler = (req, res) => void app.handle(req, res);
    const context = await browser.newContext({ extraHTTPHeaders: { origin: applicationOrigin } });
    await context.addCookies([
      { name: SESSION_COOKIE_NAME, value: session.token, url: base, httpOnly: true, sameSite: "Strict" },
      { name: SAAS_DESKTOP_ACCESS_COOKIE, value: grant.token, url: base, httpOnly: true, sameSite: "Strict" },
    ]);
    await context.route(`${base}${DESKTOP_PATH}`, async (route) => {
      if (route.request().method() !== "DELETE") return route.continue();
      const response = await fetch(`${base}${DESKTOP_PATH}`, {
        method: "DELETE",
        headers: {
          origin: applicationOrigin,
          cookie: `${SESSION_COOKIE_NAME}=${session.token}; ${SAAS_DESKTOP_ACCESS_COOKIE}=${grant.token}`,
        },
      });
      await route.fulfill({ status: response.status });
    });
    const requests: string[] = [];
    context.on("request", (request) => requests.push(request.url()));
    const page = await context.newPage();
    try {
      await page.goto(base, { waitUntil: "domcontentloaded" });
      expect(await page.evaluate(() => document.cookie)).not.toContain(SESSION_COOKIE_NAME);
      expect(await page.evaluate(() => document.cookie)).not.toContain(SAAS_DESKTOP_ACCESS_COOKIE);
      const panel = page.getByRole("region", { name: "Remote desktop" });
      await expect(panel.getByRole("status")).toContainText("access is active");
      const viewer = panel.getByRole("img", { name: "Live view of your tenant desktop" });
      await expect(viewer).toBeVisible();
      await expect.poll(() => viewer.evaluate((image: HTMLImageElement) => ({
        complete: image.complete,
        width: image.naturalWidth,
        height: image.naturalHeight,
      }))).toEqual({ complete: true, width: 1, height: 1 });
      expect(new URL((await viewer.getAttribute("src"))!, base).href).toBe(`${base}${DESKTOP_PATH}/view`);
      expect(requests.some((url) => url === `${base}${DESKTOP_PATH}/view`)).toBe(true);
      expect(requests.filter((url) => url.includes("desktop") || url.includes("computer"))).toEqual([
        `${base}${DESKTOP_PATH}`,
        `${base}${DESKTOP_PATH}/view`,
      ]);
      await expectRedacted(page);

      const revokedResponse = page.waitForResponse((response) =>
        response.url() === `${base}${DESKTOP_PATH}` && response.request().method() === "DELETE",
      );
      await panel.getByRole("button", { name: "Revoke access" }).click();
      expect((await revokedResponse).status()).toBe(204);
      await expect(panel.getByRole("status")).toContainText("access was revoked");
      await expect(viewer).toHaveCount(0);
      await expect.poll(() => providerSignal?.aborted).toBe(true);
    } finally {
      await context.close();
      server.close();
      server.closeAllConnections();
      await once(server, "close");
      db.close();
    }
  });

  test("announces initial loading, grants from the keyboard, and revokes one-shot access", async ({ browser }) => {
    const checkGate = deferred();
    const grantGate = deferred();
    const revokeGate = deferred();
    const opened = await openSaas(browser, {
      async desktop(route, method) {
        if (method === "GET") {
          await checkGate.promise;
          await json(route, 410, { error: "desktop access expired" });
        } else if (method === "POST") {
          await grantGate.promise;
          await json(route, 201, { access: { expiresAt: Date.now() + 60_000 } });
        } else {
          await revokeGate.promise;
          await route.fulfill({ status: 204 });
        }
      },
    });
    try {
      const { counts, page } = opened;
      const panel = page.getByRole("region", { name: "Remote desktop" });
      await expect(panel.getByRole("status")).toContainText("Checking remote desktop access");
      await expect(panel.getByRole("status")).toHaveAttribute("aria-busy", "true");
      checkGate.release();
      const request = panel.getByRole("button", { name: "Request access" });
      await expect(request).toBeVisible();
      await request.focus();
      await page.keyboard.press("Enter");
      await expect(panel.getByRole("status")).toContainText("Requesting scoped access");
      expect(counts.request).toBe(1);
      grantGate.release();
      const active = panel.getByRole("status").filter({ hasText: "access is active" });
      await expect(active).toBeFocused();
      await expect(active).toContainText("less than two minutes");
      await axeScan(page, "grant success");
      await expectRedacted(page);

      const revoke = panel.getByRole("button", { name: "Revoke access" });
      await revoke.focus();
      await page.keyboard.press("Enter");
      await expect(panel.getByRole("status")).toContainText("Revoking remote desktop access");
      expect(counts.revoke).toBe(1);
      revokeGate.release();
      const revoked = panel.getByRole("status").filter({ hasText: "was revoked" });
      await expect(revoked).toBeFocused();
      await expect(panel.getByRole("button", { name: "Request access" })).toBeVisible();
      await axeScan(page, "revoked");
    } finally {
      checkGate.release();
      grantGate.release();
      revokeGate.release();
      await closeSaas(opened.context, opened.harness);
    }
  });

  test("renders generic denial, then replaces it with a successful retry", async ({ browser }) => {
    const opened = await openSaas(browser, {
      async desktop(route, method, requestNumber) {
        if (method === "GET") return json(route, 410, { error: "absent" });
        if (method === "POST" && requestNumber === 1) return json(route, 403, { error: RAW_DETAIL });
        if (method === "POST") return json(route, 201, { access: { expiresAt: Date.now() + 60_000 } });
        return route.fulfill({ status: 204 });
      },
    });
    try {
      const panel = opened.page.getByRole("region", { name: "Remote desktop" });
      await panel.getByRole("button", { name: "Request access" }).click();
      const denied = panel.getByRole("alert");
      await expect(denied).toContainText("isn’t available for this workspace");
      await expect(denied).toBeFocused();
      await axeScan(opened.page, "grant denial");
      await expectRedacted(opened.page);
      await panel.getByRole("button", { name: "Request access" }).click();
      await expect(panel.getByRole("status").filter({ hasText: "access is active" })).toBeFocused();
      expect(opened.counts.request).toBe(2);
    } finally {
      await closeSaas(opened.context, opened.harness);
    }
  });

  test("announces expiry and can issue a fresh scoped grant", async ({ browser }) => {
    const opened = await openSaas(browser, {
      async desktop(route, method) {
        if (method === "GET") return json(route, 410, { error: "absent" });
        if (method === "POST") return json(route, 201, { access: { expiresAt: Date.now() + 150 } });
        return route.fulfill({ status: 204 });
      },
    });
    try {
      const panel = opened.page.getByRole("region", { name: "Remote desktop" });
      await panel.getByRole("button", { name: "Request access" }).click();
      const expired = panel.getByRole("alert");
      await expect(expired).toContainText("access expired", { timeout: 2_000 });
      await expect(expired).toBeFocused();
      await axeScan(opened.page, "grant expiry");
      await panel.getByRole("button", { name: "Request access" }).click();
      await expect.poll(() => opened.counts.request).toBe(2);
    } finally {
      await closeSaas(opened.context, opened.harness);
    }
  });

  test("recovers through network, server, timeout, and retry outcomes without leaking detail", async ({ browser }) => {
    test.setTimeout(25_000);
    const timeoutGate = deferred();
    const opened = await openSaas(browser, {
      async desktop(route, method, requestNumber) {
        if (method === "GET") return json(route, 410, { error: "absent" });
        if (method !== "POST") return route.fulfill({ status: 204 });
        if (requestNumber === 1) return route.abort("connectionrefused");
        if (requestNumber === 2) return json(route, 500, { error: RAW_DETAIL });
        if (requestNumber === 3) {
          await timeoutGate.promise;
          return json(route, 503, { error: RAW_DETAIL }).catch(() => undefined);
        }
        return json(route, 201, { access: { expiresAt: Date.now() + 60_000 } });
      },
    });
    try {
      const panel = opened.page.getByRole("region", { name: "Remote desktop" });
      const request = panel.getByRole("button", { name: "Request access" });
      await request.click();
      let failure = panel.getByRole("alert");
      await expect(failure).toContainText("couldn’t update remote desktop access");
      await expect(failure).toBeFocused();
      await expectRedacted(opened.page);
      await panel.getByRole("button", { name: "Try again" }).click();
      failure = panel.getByRole("alert");
      await expect(failure).toBeFocused();
      await expectRedacted(opened.page);
      await panel.getByRole("button", { name: "Try again" }).click();
      await expect(panel.getByRole("status")).toContainText("Requesting scoped access");
      await expect(panel.getByRole("alert")).toBeFocused({ timeout: 7_000 });
      await axeScan(opened.page, "network server timeout failure");
      await panel.getByRole("button", { name: "Try again" }).click();
      await expect(panel.getByRole("status").filter({ hasText: "access is active" })).toBeFocused();
      expect(opened.counts.request).toBe(4);
      await axeScan(opened.page, "retry recovery");
    } finally {
      timeoutGate.release();
      await closeSaas(opened.context, opened.harness);
    }
  });

  test("retries an initial status failure and restores the request action", async ({ browser }) => {
    const opened = await openSaas(browser, {
      async desktop(route, method, requestNumber) {
        if (method === "GET" && requestNumber === 1) return json(route, 503, { error: RAW_DETAIL });
        if (method === "GET") return json(route, 410, { error: "absent" });
        if (method === "POST") return json(route, 201, { access: { expiresAt: Date.now() + 60_000 } });
        return route.fulfill({ status: 204 });
      },
    });
    try {
      const panel = opened.page.getByRole("region", { name: "Remote desktop" });
      const failure = panel.getByRole("alert");
      await expect(failure).toBeFocused();
      await expectRedacted(opened.page);
      await panel.getByRole("button", { name: "Try again" }).click();
      await expect(panel.getByRole("button", { name: "Request access" })).toBeVisible();
      expect(opened.counts.check).toBe(2);
    } finally {
      await closeSaas(opened.context, opened.harness);
    }
  });
});
