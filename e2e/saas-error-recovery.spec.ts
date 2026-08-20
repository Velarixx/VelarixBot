import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test, type Browser, type BrowserContext, type Page } from "playwright/test";

import { bootHarness, type BootedHarness } from "../server/testing/harness.ts";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const VITE_CLI = join(REPO, "node_modules", "vite", "bin", "vite.js");
const AXE_PATH = join(REPO, "node_modules", "axe-core", "axe.min.js");
const RECOVERABLE_RENDER_FAILURE_EVENT = "velarix:e2e-recoverable-render-failure";
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

function buildRecoverableSaasClient(): void {
  execFileSync(process.execPath, [VITE_CLI, "build", "--logLevel", "warn"], {
    cwd: REPO,
    env: {
      ...process.env,
      VITE_VELARIX_APP_MODE: "saas",
      VITE_VELARIX_E2E_RENDER_FAILURE: "enabled",
    },
    stdio: "pipe",
  });
}

async function openAuthenticatedSaas(
  browser: Browser,
): Promise<{ context: BrowserContext; harness: BootedHarness; page: Page; apiUrls: string[] }> {
  const harness = await bootHarness({
    instances: {},
    env: { OMB_STATIC_DIR: join(REPO, "dist") },
  });
  const context = await browser.newContext({
    extraHTTPHeaders: { authorization: `Bearer ${harness.token}` },
  });
  const apiUrls: string[] = [];
  context.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin === harness.base && url.pathname.startsWith("/api/")) {
      apiUrls.push(`${url.pathname}${url.search}`);
    }
  });
  await context.route(`${harness.base}/api/session`, (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ user: { id: "123e4567-e89b-42d3-a456-426614174000" } }),
  }));
  await context.route(`${harness.base}/api/desktop-access`, (route) => route.fulfill({
    status: 410,
    contentType: "application/json",
    body: JSON.stringify({ error: "desktop access expired" }),
  }));
  await context.route(`${harness.base}/api/bots?messages=0`, (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(SAFE_CATALOG),
  }));
  const page = await context.newPage();
  await page.goto(harness.base, { waitUntil: "domcontentloaded" });
  return { context, harness, page, apiUrls };
}

async function closeSaas(context: BrowserContext, harness: BootedHarness): Promise<void> {
  await context.close();
  await harness.stop();
}

async function expectNoAxeViolations(page: Page): Promise<void> {
  await page.addScriptTag({ path: AXE_PATH });
  const violations = await page.evaluate(async () => {
    const axe = (window as typeof window & {
      axe: { run(root: Document, options: unknown): Promise<{ violations: unknown[] }> };
    }).axe;
    const result = await axe.run(document, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
    });
    return result.violations;
  });
  expect(violations, `SaaS runtime error boundary axe violations:\n${JSON.stringify(violations, null, 2)}`).toEqual([]);
}

test("a recoverable SaaS render failure clears protected content and restarts safely by keyboard", async ({ browser }) => {
  test.setTimeout(60_000);
  buildRecoverableSaasClient();
  const { context, harness, page, apiUrls } = await openAuthenticatedSaas(browser);
  try {
    const catalogHeading = page.getByRole("heading", { name: "Bot catalog" });
    await expect(page.getByRole("heading", { name: "Planner" })).toBeVisible();
    await expect(catalogHeading).toBeFocused();

    await page.evaluate((eventName) => window.dispatchEvent(new Event(eventName)), RECOVERABLE_RENDER_FAILURE_EVENT);

    const alert = page.getByRole("alert");
    const errorHeading = page.getByRole("heading", { name: "We couldn’t keep this page open safely" });
    await expect(alert).toHaveAttribute("aria-live", "assertive");
    await expect(alert).toContainText("Protected content was cleared");
    await expect(errorHeading).toBeFocused();
    await expect(page.locator('[data-saas-catalog="true"]')).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Planner" })).toHaveCount(0);
    await expect(page.getByText("Injected recoverable SaaS render failure")).toHaveCount(0);
    await expectNoAxeViolations(page);

    await page.keyboard.press("Tab");
    const retry = page.getByRole("button", { name: "Try again safely" });
    await expect(retry).toBeFocused();
    const focusStyle = await retry.evaluate((element) => {
      const style = getComputedStyle(element);
      return { outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth };
    });
    expect(focusStyle.outlineStyle).not.toBe("none");
    expect(focusStyle.outlineWidth).not.toBe("0px");
    await page.keyboard.press("Enter");

    await expect(page.getByRole("heading", { name: "Planner" })).toBeVisible();
    await expect(catalogHeading).toBeFocused();
    await expect(page.locator('[data-saas-error-boundary="true"]')).toHaveCount(0);
    expect(apiUrls.filter((url) => url === "/api/session")).toHaveLength(2);
    expect(apiUrls.filter((url) => url === "/api/bots?messages=0")).toHaveLength(2);
    expect(apiUrls.filter((url) => url === "/api/desktop-access")).toHaveLength(2);
    expect(new Set(apiUrls)).toEqual(new Set(["/api/session", "/api/bots?messages=0", "/api/desktop-access"]));
  } finally {
    await closeSaas(context, harness);
  }
});
