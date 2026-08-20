import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test, type Locator, type Route } from "playwright/test";

import { bootHarness } from "../server/testing/harness.ts";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const VITE_CLI = join(REPO, "node_modules", "vite", "bin", "vite.js");
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

if (process.env.VELARIX_PLAYWRIGHT_CHANNEL) {
  test.use({ channel: process.env.VELARIX_PLAYWRIGHT_CHANNEL });
}

function buildSaasClient(): void {
  execFileSync(process.execPath, [VITE_CLI, "build", "--logLevel", "warn"], {
    cwd: REPO,
    env: { ...process.env, VITE_VELARIX_APP_MODE: "saas" },
    stdio: "pipe",
  });
}

async function expectProgressAnimation(indicator: Locator, animationName: "none" | "spin"): Promise<void> {
  await expect(indicator).toBeVisible();
  await expect(indicator).toHaveAttribute("aria-hidden", "true");
  expect(await indicator.evaluate((element) => getComputedStyle(element).animationName)).toBe(animationName);
}

test("SaaS progress indicators honor reduced motion and keep live status announcements", async ({ browser }) => {
  test.setTimeout(90_000);
  buildSaasClient();

  for (const reducedMotion of ["reduce", "no-preference"] as const) {
    const harness = await bootHarness({
      instances: {},
      env: { OMB_STATIC_DIR: join(REPO, "dist") },
    });
    const context = await browser.newContext({
      extraHTTPHeaders: { authorization: `Bearer ${harness.token}` },
      reducedMotion,
    });
    let sessionRoute: Route | undefined;
    let catalogRoute: Route | undefined;
    let createRoute: Route | undefined;
    let signOutRoute: Route | undefined;
    await context.route(`${harness.base}/api/session`, (route) => { sessionRoute = route; });
    await context.route(`${harness.base}/api/desktop-access`, (route) => route.fulfill({
      status: 410,
      contentType: "application/json",
      body: JSON.stringify({ error: "desktop access expired" }),
    }));
    await context.route(`${harness.base}/api/bots?messages=0`, (route) => { catalogRoute = route; });
    await context.route(`${harness.base}/api/bots`, (route) => { createRoute = route; });
    await context.route(`${harness.base}/api/auth/sign-out`, (route) => { signOutRoute = route; });
    const page = await context.newPage();
    const expectedAnimation = reducedMotion === "reduce" ? "none" : "spin";

    try {
      await page.goto(harness.base, { waitUntil: "domcontentloaded" });

      const sessionStatus = page.getByRole("status").filter({ hasText: "Checking your session" });
      await expect(sessionStatus).toHaveAttribute("aria-live", "polite");
      await expectProgressAnimation(
        sessionStatus.locator('[data-saas-progress-indicator="true"]'),
        expectedAnimation,
      );
      expect(sessionRoute).toBeDefined();
      await sessionRoute!.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ user: { id: "123e4567-e89b-42d3-a456-426614174000" } }),
      });

      const catalogStatus = page.getByRole("status").filter({ hasText: "Loading bot catalog" });
      await expect(catalogStatus).toHaveAttribute("aria-live", "polite");
      await expectProgressAnimation(
        catalogStatus.locator('[data-saas-progress-indicator="true"]'),
        expectedAnimation,
      );
      expect(catalogRoute).toBeDefined();
      await catalogRoute!.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(SAFE_CATALOG),
      });

      await page.getByRole("button", { name: "Create bot" }).click();
      const creationStatus = page.getByRole("status").filter({ hasText: "Creating your bot" });
      await expect(creationStatus).toHaveAttribute("aria-live", "polite");
      await expectProgressAnimation(
        page.getByRole("button", { name: "Creating…" }).locator('[data-saas-progress-indicator="true"]'),
        expectedAnimation,
      );
      expect(createRoute).toBeDefined();
      await createRoute!.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({ error: "quota_reached" }),
      });

      await page.getByRole("button", { name: "Sign out" }).click();
      const dialog = page.getByRole("dialog", { name: "Sign out on this device?" });
      await dialog.getByRole("button", { name: "Sign out" }).click();
      const signOutStatus = page.getByRole("status").filter({ hasText: "Signing out" });
      await expect(signOutStatus).toHaveAttribute("aria-live", "polite");
      await expectProgressAnimation(
        signOutStatus.locator('[data-saas-progress-indicator="true"]'),
        expectedAnimation,
      );
      expect(signOutRoute).toBeDefined();
      await signOutRoute!.fulfill({ status: 204, body: "" });
      await expect(page.getByRole("heading", { name: "You’re signed out" })).toBeVisible();
    } finally {
      await context.close();
      await harness.stop();
    }
  }
});
