import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
  type Route,
} from "playwright/test";

import { bootHarness, type BootedHarness } from "../server/testing/harness.ts";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const VITE_CLI = join(REPO, "node_modules", "vite", "bin", "vite.js");
const AXE_PATH = createRequire(import.meta.url).resolve("axe-core/axe.min.js");
const USER_ID = "123e4567-e89b-42d3-a456-426614174000";
const RAW_DETAIL = "raw-secret-upstream-detail-must-not-render";

const EMPTY_CATALOG = { bots: [] };
const EXISTING_CATALOG = {
  bots: [{
    name: "Planner",
    title: "Planning assistant",
    description: "Builds reviewable plans.",
    color: "green",
    messages: [],
    hasMore: false,
  }],
};
const CREATED_CATALOG = {
  bots: [{
    name: "Default bot",
    title: "Safe default",
    description: "Ready after the authoritative refresh.",
    color: "blue",
    messages: [],
    hasMore: false,
  }],
};

interface RequestCounts {
  catalog: number;
  create: number;
}

interface SaasOptions {
  catalog?: (route: Route, requestNumber: number) => Promise<void> | void;
  create?: (route: Route, requestNumber: number) => Promise<void> | void;
}

function buildSaasClient(): void {
  execFileSync(process.execPath, [VITE_CLI, "build", "--logLevel", "warn"], {
    cwd: REPO,
    env: { ...process.env, VITE_VELARIX_APP_MODE: "saas" },
    stdio: "pipe",
  });
}

async function fulfillJson(route: Route, status: number, body: unknown): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function openSaas(
  browser: Browser,
  options: SaasOptions = {},
): Promise<{
  context: BrowserContext;
  counts: RequestCounts;
  harness: BootedHarness;
  page: Page;
}> {
  const harness = await bootHarness({
    instances: {},
    env: { OMB_STATIC_DIR: join(REPO, "dist") },
  });
  const context = await browser.newContext({
    extraHTTPHeaders: { authorization: `Bearer ${harness.token}` },
  });
  const counts: RequestCounts = { catalog: 0, create: 0 };

  await context.route(`${harness.base}/api/session`, (route) => fulfillJson(route, 200, {
    user: { id: USER_ID },
  }));
  await context.route(`${harness.base}/api/desktop-access`, (route) => fulfillJson(route, 410, {
    error: "desktop access expired",
  }));
  await context.route(`${harness.base}/api/bots?messages=0`, async (route) => {
    counts.catalog += 1;
    if (options.catalog) {
      await options.catalog(route, counts.catalog);
      return;
    }
    await fulfillJson(route, 200, EMPTY_CATALOG);
  });
  await context.route(`${harness.base}/api/bots`, async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    counts.create += 1;
    if (options.create) {
      await options.create(route, counts.create);
      return;
    }
    await fulfillJson(route, 201, { bot: {} });
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
      axe: {
        run(
          context: Document,
          options: unknown,
        ): Promise<{ violations: unknown[] }>;
      };
    }).axe;
    const result = await axe.run(
      document,
      { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] } },
    );
    return result.violations;
  });
  expect(violations, `${label} axe violations:\n${JSON.stringify(violations, null, 2)}`).toEqual([]);
}

async function expectContrastAtLeast(locator: Locator, minimum = 4.5): Promise<void> {
  const contrast = await locator.evaluate((element) => {
    const style = getComputedStyle(element);
    const luminance = (color: string) => {
      const channels = color.match(/[\d.]+/g)?.slice(0, 3).map((value) => Number(value) / 255);
      if (!channels || channels.length !== 3) throw new Error(`Unsupported computed color: ${color}`);
      const linear = channels.map((channel) => (
        channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
      ));
      return (0.2126 * linear[0]) + (0.7152 * linear[1]) + (0.0722 * linear[2]);
    };
    const foreground = luminance(style.color);
    const background = luminance(style.backgroundColor);
    return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
  });
  expect(contrast).toBeGreaterThanOrEqual(minimum);
}

async function expectNoRawDetail(page: Page): Promise<void> {
  await expect(page.getByText(RAW_DETAIL, { exact: false })).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText(/stack trace|upstream response|internal server/i);
}

function deferred(): { promise: Promise<void>; release(): void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

test.describe("SaaS default-bot creation outcomes", () => {
  test.beforeAll(() => buildSaasClient());

  test("keeps protected state during create/refetch, suppresses duplicate POSTs, and focuses announced success", async ({ browser }) => {
    const createGate = deferred();
    const refreshGate = deferred();
    const opened = await openSaas(browser, {
      catalog: async (route, requestNumber) => {
        if (requestNumber === 1) {
          await fulfillJson(route, 200, EXISTING_CATALOG);
          return;
        }
        await refreshGate.promise;
        await fulfillJson(route, 200, CREATED_CATALOG);
      },
      create: async (route) => {
        await createGate.promise;
        await fulfillJson(route, 201, { bot: {} });
      },
    });
    try {
      const { counts, page } = opened;
      await expect(page.getByRole("heading", { name: "Planner" })).toBeVisible();
      const createButton = page.getByRole("button", { name: "Create bot" });
      const stableCreateButton = page.locator("header button").first();

      await axeScan(page, "catalog default action");
      await expectContrastAtLeast(createButton);
      await page.keyboard.press("Tab");
      await expect(createButton).toBeFocused();
      const focusStyle = await createButton.evaluate((element) => {
        const style = getComputedStyle(element);
        return { outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth };
      });
      expect(focusStyle.outlineStyle).not.toBe("none");
      expect(focusStyle.outlineWidth).not.toBe("0px");
      await createButton.hover();
      await expectContrastAtLeast(createButton);
      await axeScan(page, "catalog hovered action");

      await createButton.evaluate((button: HTMLButtonElement) => {
        button.click();
        button.click();
      });
      await expect.poll(() => counts.create).toBe(1);
      await expect(page.getByRole("status").filter({ hasText: "Creating your bot" })).toBeVisible();
      await expect(page.locator("main[data-saas-catalog]")).toHaveAttribute("aria-busy", "true");
      await expect(stableCreateButton).toBeDisabled();
      await expectContrastAtLeast(stableCreateButton);
      await expect(page.getByRole("button", { name: "Sign out" })).toBeEnabled();
      await expect(page.getByRole("heading", { name: "Planner" })).toBeVisible();
      await axeScan(page, "creating");

      createGate.release();
      await expect(page.getByRole("status").filter({ hasText: "Refreshing the catalog" })).toBeVisible();
      await expect.poll(() => counts.catalog).toBe(2);
      await expect(stableCreateButton).toBeDisabled();
      await expect(page.getByRole("heading", { name: "Planner" })).toBeVisible();
      expect(counts.create).toBe(1);
      await axeScan(page, "post-create refetching");

      refreshGate.release();
      const success = page.locator("#creation-feedback");
      await expect(success).toHaveRole("status");
      await expect(success).toContainText("Bot created. The catalog is up to date.");
      await expect(success).toBeFocused();
      await expect(page.getByRole("heading", { name: "Default bot" })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Planner" })).toHaveCount(0);
      await expect(stableCreateButton).toBeEnabled();
      expect(counts).toEqual({ catalog: 2, create: 1 });
      await axeScan(page, "creation success");
    } finally {
      createGate.release();
      refreshGate.release();
      await closeSaas(opened.context, opened.harness);
    }
  });

  test("a create 401 clears protected content and returns focus to the ended-session boundary", async ({ browser }) => {
    const opened = await openSaas(browser, {
      catalog: (route) => fulfillJson(route, 200, EXISTING_CATALOG),
      create: (route) => fulfillJson(route, 401, { error: RAW_DETAIL }),
    });
    try {
      const { counts, page } = opened;
      await expect(page.getByRole("heading", { name: "Planner" })).toBeVisible();
      await page.getByRole("button", { name: "Create bot" }).click();

      const heading = page.getByRole("heading", { name: "Your session ended" });
      await expect(heading).toBeVisible();
      await expect(heading).toBeFocused();
      await expect(page.locator("main[data-saas-catalog]")).toHaveCount(0);
      await expect(page.getByRole("heading", { name: "Planner" })).toHaveCount(0);
      await expectNoRawDetail(page);
      expect(counts).toEqual({ catalog: 1, create: 1 });
      await axeScan(page, "create session loss");
    } finally {
      await closeSaas(opened.context, opened.harness);
    }
  });

  test("a quota 409 focuses a generic alert and disables every creation entry point", async ({ browser }) => {
    const opened = await openSaas(browser, {
      create: (route) => fulfillJson(route, 409, { error: RAW_DETAIL }),
    });
    try {
      const { counts, page } = opened;
      await expect(page.getByRole("heading", { name: "Create your first bot" })).toBeVisible();
      await page.getByRole("button", { name: "Create first bot" }).click();

      const alert = page.locator("#creation-feedback");
      await expect(alert).toHaveRole("alert");
      await expect(alert).toContainText("Bot limit reached");
      await expect(alert).toBeFocused();
      await expect(page.getByRole("button", { name: /Create (bot|first bot)/ })).toHaveCount(2);
      for (const button of await page.getByRole("button", { name: /Create (bot|first bot)/ }).all()) {
        await expect(button).toBeDisabled();
      }
      await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(0);
      await expectNoRawDetail(page);
      expect(counts).toEqual({ catalog: 1, create: 1 });
      await axeScan(page, "quota denial");
    } finally {
      await closeSaas(opened.context, opened.harness);
    }
  });

  for (const failure of ["timeout", "network", "server"] as const) {
    test(`maps ${failure} failure to the same focused, retryable, redacted state`, async ({ browser }) => {
      test.setTimeout(20_000);
      const timeoutGate = deferred();
      const opened = await openSaas(browser, {
        create: async (route) => {
          if (failure === "timeout") {
            await timeoutGate.promise;
            await fulfillJson(route, 201, { bot: {} }).catch(() => undefined);
          } else if (failure === "network") {
            await route.abort("connectionfailed");
          } else {
            await fulfillJson(route, 503, { error: RAW_DETAIL, stack: "stack trace" });
          }
        },
      });
      try {
        const { counts, page } = opened;
        await expect(page.getByRole("heading", { name: "Create your first bot" })).toBeVisible();
        await page.getByRole("button", { name: "Create first bot" }).click();

        const alert = page.locator("#creation-feedback");
        await expect(alert).toHaveRole("alert", { timeout: 8_000 });
        await expect(alert).toContainText("finish creating the bot");
        await expect(alert).toContainText("No details were retained");
        await expect(alert).toBeFocused();
        await expect(page.getByRole("button", { name: "Try again" })).toBeEnabled();
        for (const button of await page.getByRole("button", { name: /Create (bot|first bot)/ }).all()) {
          await expect(button).toBeEnabled();
        }
        await expectNoRawDetail(page);
        expect(counts).toEqual({ catalog: 1, create: 1 });
        await axeScan(page, `${failure} failure`);
      } finally {
        timeoutGate.release();
        await closeSaas(opened.context, opened.harness);
      }
    });
  }

  test("retries a failed POST exactly once and recovers through one authoritative refresh", async ({ browser }) => {
    const opened = await openSaas(browser, {
      catalog: (route, requestNumber) => fulfillJson(
        route,
        200,
        requestNumber === 1 ? EMPTY_CATALOG : CREATED_CATALOG,
      ),
      create: (route, requestNumber) => fulfillJson(
        route,
        requestNumber === 1 ? 500 : 201,
        requestNumber === 1 ? { error: RAW_DETAIL } : { bot: {} },
      ),
    });
    try {
      const { counts, page } = opened;
      await expect(page.getByRole("heading", { name: "Create your first bot" })).toBeVisible();
      await page.getByRole("button", { name: "Create first bot" }).click();
      const failure = page.locator("#creation-feedback");
      await expect(failure).toHaveRole("alert");
      await expect(failure).toBeFocused();
      await expectNoRawDetail(page);
      expect(counts).toEqual({ catalog: 1, create: 1 });

      await page.getByRole("button", { name: "Try again" }).click();
      const success = page.locator("#creation-feedback");
      await expect(success).toContainText("Bot created. The catalog is up to date.");
      await expect(success).toBeFocused();
      await expect(page.getByRole("heading", { name: "Default bot" })).toBeVisible();
      expect(counts).toEqual({ catalog: 2, create: 2 });
      await axeScan(page, "POST retry recovery");
    } finally {
      await closeSaas(opened.context, opened.harness);
    }
  });

  test("after a known 201, retry issues only the failed refresh and then replaces protected state", async ({ browser }) => {
    const opened = await openSaas(browser, {
      catalog: (route, requestNumber) => {
        if (requestNumber === 1) return fulfillJson(route, 200, EXISTING_CATALOG);
        if (requestNumber === 2) return fulfillJson(route, 503, { error: RAW_DETAIL });
        return fulfillJson(route, 200, CREATED_CATALOG);
      },
    });
    try {
      const { counts, page } = opened;
      await expect(page.getByRole("heading", { name: "Planner" })).toBeVisible();
      await page.getByRole("button", { name: "Create bot" }).click();

      const failure = page.locator("#creation-feedback");
      await expect(failure).toHaveRole("alert");
      await expect(failure).toBeFocused();
      await expect(page.getByRole("heading", { name: "Planner" })).toBeVisible();
      for (const button of await page.getByRole("button", { name: "Create bot" }).all()) {
        await expect(button).toBeDisabled();
      }
      await expectNoRawDetail(page);
      expect(counts).toEqual({ catalog: 2, create: 1 });
      await axeScan(page, "refresh-only failure");

      await page.getByRole("button", { name: "Try again" }).click();
      const success = page.locator("#creation-feedback");
      await expect(success).toContainText("Bot created. The catalog is up to date.");
      await expect(success).toBeFocused();
      await expect(page.getByRole("heading", { name: "Default bot" })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Planner" })).toHaveCount(0);
      expect(counts).toEqual({ catalog: 3, create: 1 });
      await axeScan(page, "refresh-only retry recovery");
    } finally {
      await closeSaas(opened.context, opened.harness);
    }
  });
});
