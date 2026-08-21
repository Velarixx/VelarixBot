import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test, type Browser, type BrowserContext, type Page, type Route } from "playwright/test";

import { bootHarness, type BootedHarness } from "../server/testing/harness.ts";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const VITE_CLI = join(REPO, "node_modules", "vite", "bin", "vite.js");
const AXE_PATH = createRequire(import.meta.url).resolve("axe-core/axe.min.js");
const UNAPPROVED_PRODUCT_PATH = /^\/api\/(?:instances|config|routines|events|groups|approvals|computers|workspaces)(?:\/|$)/;
let sessionBuildDir: string;

const SAFE_CATALOG = {
  bots: [{
    name: "Planner",
    title: "Planning assistant",
    description: "Builds reviewable plans.",
    color: "green",
    messages: [],
    hasMore: false,
  }],
};

// CI uses Playwright's pinned browser. Local review can opt into an installed
// stable channel without weakening the default reproducible harness.
if (process.env.VELARIX_PLAYWRIGHT_CHANNEL) {
  test.use({ channel: process.env.VELARIX_PLAYWRIGHT_CHANNEL });
}

function buildClient(mode: string): void {
  execFileSync(process.execPath, [
    VITE_CLI,
    "build",
    "--logLevel",
    "warn",
    "--outDir",
    sessionBuildDir,
    "--emptyOutDir",
  ], {
    cwd: REPO,
    env: { ...process.env, VITE_VELARIX_APP_MODE: mode },
    stdio: "pipe",
  });
}

async function openBuiltClient(
  browser: Browser,
  options: {
    session?: "authenticated" | "unauthenticated";
    sessionHandler?: (route: Route, attempt: number) => Promise<void> | void;
    catalog?: { status: number; body: unknown };
    path?: string;
    staticDir?: string;
  },
): Promise<{ context: BrowserContext; harness: BootedHarness; page: Page; apiPaths: string[]; apiUrls: string[] }> {
  const harness = await bootHarness({
    instances: {},
    env: { OMB_STATIC_DIR: options.staticDir ?? sessionBuildDir },
  });
  const context = await browser.newContext({
    extraHTTPHeaders: { authorization: `Bearer ${harness.token}` },
  });
  const apiPaths: string[] = [];
  const apiUrls: string[] = [];
  context.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin === harness.base && url.pathname.startsWith("/api/")) {
      apiPaths.push(url.pathname);
      apiUrls.push(`${url.pathname}${url.search}`);
    }
  });
  await context.addInitScript(() => {
    const desktopCopy = /Welcome to VelarixBot|Connecting to the bot server|No bots yet|Create your first bot/;
    const inspect = () => {
      if (desktopCopy.test(document.body?.innerText ?? "")) {
        (window as typeof window & { __desktopContentFlashed?: boolean }).__desktopContentFlashed = true;
      }
    };
    new MutationObserver(inspect).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  });
  if (options.sessionHandler) {
    let attempt = 0;
    await context.route(`${harness.base}/api/session`, (route) => options.sessionHandler!(route, ++attempt));
  } else if (options.session) {
    await context.route(`${harness.base}/api/session`, (route) => route.fulfill({
      status: options.session === "authenticated" ? 200 : 401,
      contentType: "application/json",
      body: JSON.stringify(options.session === "authenticated"
        ? { user: { id: "123e4567-e89b-42d3-a456-426614174000" } }
        : { error: "unauthorized" }),
    }));
  }
  if (options.session === "authenticated") {
    await context.route(`${harness.base}/api/desktop-access`, (route) => route.fulfill({
      status: 410,
      contentType: "application/json",
      body: JSON.stringify({ error: "desktop access expired" }),
    }));
    const catalog = options.catalog ?? { status: 200, body: SAFE_CATALOG };
    await context.route(`${harness.base}/api/bots?messages=0`, (route) => route.fulfill({
      status: catalog.status,
      contentType: "application/json",
      body: JSON.stringify(catalog.body),
    }));
  }
  const page = await context.newPage();
  await page.goto(`${harness.base}${options.path ?? ""}`, { waitUntil: "domcontentloaded" });
  return { context, harness, page, apiPaths, apiUrls };
}

async function closeBuiltClient(context: BrowserContext, harness: BootedHarness): Promise<void> {
  await context.close();
  await harness.stop();
}

async function axeScan(page: Page, label: string): Promise<void> {
  await page.addScriptTag({ path: AXE_PATH });
  const violations = await page.evaluate(async () => {
    const axe = (window as typeof window & {
      axe: { run(context: Document, options: unknown): Promise<{ violations: unknown[] }> };
    }).axe;
    const result = await axe.run(document, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
    });
    return result.violations;
  });
  expect(violations, `${label} axe violations:\n${JSON.stringify(violations, null, 2)}`).toEqual([]);
}

async function expectClosedAndRedacted(page: Page, secrets: string[] = []): Promise<void> {
  await expect(page.locator('[data-saas-catalog="true"]')).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Bot catalog" })).toHaveCount(0);
  const body = page.locator("body");
  for (const secret of secrets) await expect(body).not.toContainText(secret);
}

async function fulfillSession(route: Route, status: 200 | 401): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(status === 200
      ? { user: { id: "123e4567-e89b-42d3-a456-426614174000" } }
      : { error: "unauthorized" }),
  });
}

test.describe.serial("built fail-closed session boundary", () => {
  test.beforeAll(() => {
    sessionBuildDir = mkdtempSync(join(tmpdir(), "velarix-session-boundary-"));
    buildClient("saas");
  });
  test.afterAll(() => rmSync(sessionBuildDir, { recursive: true, force: true }));

  test("keeps initial loading closed, then exposes an accessible unauthenticated sign-in", async ({ browser }) => {
    let pendingProbe: Route | undefined;
    const signIn = await openBuiltClient(browser, {
      sessionHandler: (route) => { pendingProbe = route; },
    });
    try {
      const checking = signIn.page.getByRole("status").filter({ hasText: "Checking your session" });
      await expect(checking).toBeVisible();
      await expect(checking).toHaveAttribute("aria-live", "polite");
      await expect(signIn.page.locator("main[data-session-boundary]")).toHaveAttribute("aria-busy", "true");
      await expectClosedAndRedacted(signIn.page, ["123e4567-e89b-42d3-a456-426614174000"]);
      await axeScan(signIn.page, "initial session check");

      await expect.poll(() => Boolean(pendingProbe)).toBe(true);
      await fulfillSession(pendingProbe!, 401);
      const heading = signIn.page.getByRole("heading", { name: "Sign in to continue" });
      await expect(heading).toBeFocused();
      await axeScan(signIn.page, "sign-in required");

      await signIn.page.keyboard.press("Tab");
      const primaryAction = signIn.page.getByRole("button", { name: "Continue with GitHub" });
      await expect(primaryAction).toBeFocused();
      const focusStyle = await primaryAction.evaluate((element) => {
        const style = getComputedStyle(element);
        return { outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth };
      });
      expect(focusStyle.outlineStyle).not.toBe("none");
      expect(focusStyle.outlineWidth).not.toBe("0px");
      expect(signIn.apiPaths).toEqual(["/api/session"]);
      await expectClosedAndRedacted(signIn.page, ["123e4567-e89b-42d3-a456-426614174000"]);
    } finally {
      await closeBuiltClient(signIn.context, signIn.harness);
    }
  });

  test("starts only the reviewed GitHub handoff and keeps product data closed", async ({ browser }) => {
    const client = await openBuiltClient(browser, { session: "unauthenticated" });
    try {
      await client.context.route(`${client.harness.base}/api/auth/github/start`, (route) => route.abort("aborted"));
      const requestPromise = client.page.waitForRequest((request) =>
        request.url() === `${client.harness.base}/api/auth/github/start`,
      );
      await client.page.getByRole("button", { name: "Continue with GitHub" }).click();
      const request = await requestPromise;
      expect(request.method()).toBe("GET");
      expect(new URL(request.url()).search).toBe("");

      const status = client.page.getByRole("status").filter({ hasText: "Continue in GitHub to sign in" });
      await expect(status).toBeVisible();
      await expect(status).toHaveAttribute("aria-live", "polite");
      await expect(client.page.locator("main[data-session-boundary]")).toHaveAttribute("aria-busy", "true");
      await expectClosedAndRedacted(client.page);
      await axeScan(client.page, "GitHub handoff pending");

      await client.page.getByRole("button", { name: "Cancel" }).click();
      await expect(client.page.getByRole("heading", { name: "Sign in to continue" })).toBeFocused();
    } finally {
      await closeBuiltClient(client.context, client.harness);
    }
  });

  test("scrubs callback URLs and distinguishes declined from rejected handoffs", async ({ browser }) => {
    const scenarios = [
      {
        label: "declined callback",
        path: "/auth/result?outcome=sign_in_declined",
        heading: /Sign-in wasn.t completed/,
        secret: "provider-secret-declined",
      },
      {
        label: "rejected callback",
        path: "/auth/result?outcome=authenticated&code=provider-secret-rejected",
        heading: /verify that sign-in attempt/,
        secret: "provider-secret-rejected",
      },
    ];

    for (const scenario of scenarios) {
      const callback = await openBuiltClient(browser, { path: scenario.path });
      try {
        const alert = callback.page.getByRole("alert");
        const heading = callback.page.getByRole("heading", { name: scenario.heading });
        await expect(alert).toBeVisible();
        await expect(heading).toBeFocused();
        await expect(callback.page).toHaveURL(`${callback.harness.base}/`);
        await expectClosedAndRedacted(callback.page, [scenario.secret]);
        await axeScan(callback.page, scenario.label);
        expect(callback.apiPaths).toEqual([]);
      } finally {
        await closeBuiltClient(callback.context, callback.harness);
      }
    }
  });

  test("re-probes an authenticated callback before mounting protected content", async ({ browser }) => {
    let pendingProbe: Route | undefined;
    const callback = await openBuiltClient(browser, {
      path: "/auth/result?outcome=authenticated",
      sessionHandler: (route) => { pendingProbe = route; },
    });
    try {
      await expect(callback.page).toHaveURL(`${callback.harness.base}/`);
      await expect(callback.page.getByRole("status").filter({ hasText: "Checking your session" })).toBeVisible();
      await expectClosedAndRedacted(callback.page, ["123e4567-e89b-42d3-a456-426614174000"]);
      expect(callback.apiPaths).toEqual(["/api/session"]);

      await expect.poll(() => Boolean(pendingProbe)).toBe(true);
      await callback.context.route(`${callback.harness.base}/api/desktop-access`, (route) => route.fulfill({
        status: 410,
        contentType: "application/json",
        body: JSON.stringify({ error: "desktop access expired" }),
      }));
      await callback.context.route(`${callback.harness.base}/api/bots?messages=0`, (route) => route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(SAFE_CATALOG),
      }));
      await fulfillSession(pendingProbe!, 200);

      await expect(callback.page.getByRole("heading", { name: "Bot catalog" })).toBeFocused();
      await expect(callback.page.getByRole("heading", { name: "Planner" })).toBeVisible();
      await expect(callback.page.locator("body")).not.toContainText("123e4567-e89b-42d3-a456-426614174000");
      await axeScan(callback.page, "authenticated callback recovery");
      expect(new Set(callback.apiPaths)).toEqual(new Set(["/api/session", "/api/bots", "/api/desktop-access"]));
    } finally {
      await closeBuiltClient(callback.context, callback.harness);
    }
  });

  test("announces timeout, network, and server probe failures and recovers by manual retry", async ({ browser }) => {
    test.setTimeout(45_000);
    const scenarios = ["timeout", "network", "server"] as const;

    for (const scenario of scenarios) {
      const secret = `raw-${scenario}-session-secret`;
      const client = await openBuiltClient(browser, {
        sessionHandler: async (route, attempt) => {
          if (attempt > 2) return fulfillSession(route, 401);
          if (scenario === "network") return route.abort("connectionrefused");
          if (scenario === "server") {
            return route.fulfill({
              status: 503,
              contentType: "application/json",
              body: JSON.stringify({ error: "provider unavailable", token: secret }),
            });
          }
          await new Promise((resolve) => setTimeout(resolve, 5_250));
          try {
            await route.fulfill({
              status: 200,
              contentType: "application/json",
              body: JSON.stringify({ user: { id: secret } }),
            });
          } catch {
            // The app's reviewed five-second AbortController deadline wins.
          }
        },
      });
      try {
        const heading = client.page.getByRole("heading", { name: /check your session right now/ });
        await expect(heading).toBeFocused({ timeout: 15_000 });
        const status = client.page.getByRole("status").filter({ has: heading });
        await expect(status).toHaveAttribute("aria-live", "polite");
        expect(client.apiPaths).toEqual(["/api/session", "/api/session"]);
        await expectClosedAndRedacted(client.page, [secret]);
        await axeScan(client.page, `${scenario} session failure`);

        await client.page.getByRole("button", { name: "Try again" }).click();
        await expect(client.page.getByRole("heading", { name: "Sign in to continue" })).toBeFocused();
        expect(client.apiPaths).toEqual(["/api/session", "/api/session", "/api/session"]);
        await expectClosedAndRedacted(client.page, [secret]);
      } finally {
        await closeBuiltClient(client.context, client.harness);
      }
    }
  });

  test("renders an explicitly rejected callback as an assertive, focused alert", async ({ browser }) => {
    const callback = await openBuiltClient(browser, { path: "/auth/result?outcome=callback_rejected" });
    try {
      const alert = callback.page.getByRole("alert");
      const heading = callback.page.getByRole("heading", { name: /verify that sign-in attempt/ });
      await expect(alert).toBeVisible();
      await expect(heading).toBeFocused();
      await expect(callback.page).toHaveURL(`${callback.harness.base}/`);
      await axeScan(callback.page, "callback rejected");
      expect(callback.apiPaths).toEqual([]);
    } finally {
      await closeBuiltClient(callback.context, callback.harness);
    }
  });

  test("exact saas mode mounts only the boundary and restores sign-out focus", async ({ browser }) => {
    const { context, harness, page, apiPaths, apiUrls } = await openBuiltClient(browser, { session: "authenticated" });
    try {
      await expect(page.getByRole("heading", { name: "Bot catalog" })).toBeVisible();
      await expect(page.locator('[data-saas-catalog="true"]')).toBeVisible();
      await expect(page.getByText("VelarixBot SaaS")).toBeVisible();
      await expect(page.getByRole("heading", { name: "Planner" })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Bot catalog" })).toBeFocused();

      const signOut = page.getByRole("button", { name: "Sign out" });
      await signOut.click();
      await expect(page.getByRole("dialog", { name: "Sign out on this device?" })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Planner" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Cancel" })).toBeFocused();
      await page.getByRole("button", { name: "Cancel" }).click();
      await expect(signOut).toBeFocused();
      await expect(page.getByRole("heading", { name: "Planner" })).toBeVisible();

      await signOut.click();
      await expect(page.getByRole("button", { name: "Cancel" })).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(signOut).toBeFocused();

      expect(new Set(apiPaths)).toEqual(new Set(["/api/session", "/api/bots", "/api/desktop-access"]));
      expect(apiUrls.filter((url) => url.startsWith("/api/bots"))).toEqual([
        "/api/bots?messages=0",
        "/api/bots?messages=0",
        "/api/bots?messages=0",
      ]);
      expect(apiPaths.some((path) => UNAPPROVED_PRODUCT_PATH.test(path))).toBe(false);
      expect(await page.evaluate(() => Boolean(
        (window as typeof window & { __desktopContentFlashed?: boolean }).__desktopContentFlashed,
      ))).toBe(false);
    } finally {
      await closeBuiltClient(context, harness);
    }
  });

  test("a catalog 401 clears protected content and returns to the ended-session boundary", async ({ browser }) => {
    const { context, harness, page, apiUrls } = await openBuiltClient(browser, {
      session: "authenticated",
      catalog: {
        status: 401,
        body: { error: "unauthorized", token: "raw-secret-must-not-render" },
      },
    });
    try {
      await expect(page.getByRole("heading", { name: "Your session ended" })).toBeVisible();
      await expect(page.locator('[data-saas-catalog="true"]')).toHaveCount(0);
      await expect(page.getByText("raw-secret-must-not-render")).toHaveCount(0);
      expect(new Set(apiUrls)).toEqual(new Set(["/api/session", "/api/bots?messages=0", "/api/desktop-access"]));
    } finally {
      await closeBuiltClient(context, harness);
    }
  });

  test("an invalid explicit mode renders the closed alert without any API or desktop activity", async ({ browser }) => {
    buildClient("invalid-explicit-mode");
    const { context, harness, page, apiPaths } = await openBuiltClient(browser, {});
    try {
      await expect(page.getByRole("alert")).toContainText("This app can’t start safely");
      await expect(page.getByRole("alert")).toContainText("Product access remains closed");
      await page.waitForTimeout(250);
      expect(apiPaths).toEqual([]);
      expect(await page.evaluate(() => Boolean(
        (window as typeof window & { __desktopContentFlashed?: boolean }).__desktopContentFlashed,
      ))).toBe(false);
    } finally {
      await closeBuiltClient(context, harness);
    }
  });

  test("keeps the shared release build intact after the isolated invalid-mode build", async ({ browser }) => {
    const release = await openBuiltClient(browser, {
      session: "unauthenticated",
      staticDir: join(REPO, "dist"),
    });
    try {
      const welcome = release.page.getByRole("heading", { name: "Welcome to VelarixBot" });
      const signIn = release.page.getByRole("heading", { name: "Sign in to continue" });
      await expect(welcome.or(signIn)).toBeVisible();
      if (await signIn.isVisible()) {
        await expect(release.page.getByRole("button", { name: "Continue with GitHub" })).toBeVisible();
      }
      await expect(release.page.getByRole("alert").filter({ hasText: /start safely/ })).toHaveCount(0);
      await expect(release.page.getByText("Product access remains closed")).toHaveCount(0);
    } finally {
      await closeBuiltClient(release.context, release.harness);
    }
  });
});
