import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
  type Route,
} from "playwright/test";

import { bootHarness, type BootedHarness } from "../server/testing/harness.ts";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const VITE_CLI = join(REPO, "node_modules", "vite", "bin", "vite.js");
const AXE_PATH = createRequire(import.meta.url).resolve("axe-core/axe.min.js");
const USER_ID = "123e4567-e89b-42d3-a456-426614174000";
const PROTECTED_MARKER = "Planner";
const RAW_DETAIL = "raw-secret-sign-out-detail-must-not-render";
const SIGN_OUT_PATH = "/api/auth/sign-out";

const CATALOG = {
  bots: [{
    name: PROTECTED_MARKER,
    title: "Planning assistant",
    description: "Builds reviewable plans.",
    color: "green",
    messages: [],
    hasMore: false,
  }],
};

interface SignOutOptions {
  signOut?: (route: Route, requestNumber: number) => Promise<void> | void;
}

interface FetchSnapshot {
  catalogMounted: boolean;
  markerVisible: boolean;
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

async function openAuthenticatedSaas(
  browser: Browser,
  options: SignOutOptions = {},
): Promise<{
  context: BrowserContext;
  harness: BootedHarness;
  page: Page;
  signOutRequests: { count: number };
}> {
  const harness = await bootHarness({
    instances: {},
    env: { OMB_STATIC_DIR: join(REPO, "dist") },
  });
  const context = await browser.newContext({
    extraHTTPHeaders: { authorization: `Bearer ${harness.token}` },
  });
  const signOutRequests = { count: 0 };

  await context.addInitScript(({ marker, signOutPath }) => {
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const requestUrl = input instanceof Request ? input.url : input.toString();
      if (new URL(requestUrl, window.location.href).pathname === signOutPath) {
        const state = window as typeof window & { __signOutFetchSnapshot?: FetchSnapshot };
        state.__signOutFetchSnapshot = {
          catalogMounted: document.querySelector('[data-saas-catalog="true"]') !== null,
          markerVisible: document.body.innerText.includes(marker),
        };
      }
      return originalFetch(input, init);
    };
  }, { marker: PROTECTED_MARKER, signOutPath: SIGN_OUT_PATH });

  await context.route(`${harness.base}/api/session`, (route) => fulfillJson(route, 200, {
    user: { id: USER_ID },
  }));
  await context.route(`${harness.base}/api/desktop-access`, (route) => fulfillJson(route, 410, {
    error: "desktop access expired",
  }));
  await context.route(`${harness.base}/api/bots?messages=0`, (route) => fulfillJson(route, 200, CATALOG));
  await context.route(`${harness.base}${SIGN_OUT_PATH}`, async (route) => {
    expect(route.request().method()).toBe("POST");
    signOutRequests.count += 1;
    if (options.signOut) {
      await options.signOut(route, signOutRequests.count);
      return;
    }
    await route.fulfill({ status: 204 });
  });

  const page = await context.newPage();
  await page.goto(harness.base, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Bot catalog" })).toBeVisible();
  await expect(page.getByRole("heading", { name: PROTECTED_MARKER })).toBeVisible();
  return { context, harness, page, signOutRequests };
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
          context: { exclude: string[][] },
          options: unknown,
        ): Promise<{ violations: unknown[] }>;
      };
    }).axe;
    const result = await axe.run(
      // DHV-63 owns the audited baseline contrast defect on accent actions.
      { exclude: [[".bg-accent"]] },
      { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] } },
    );
    return result.violations;
  });
  expect(violations, `${label} axe violations:\n${JSON.stringify(violations, null, 2)}`).toEqual([]);
}

async function expectProtectedContentCleared(page: Page): Promise<void> {
  await expect(page.locator('[data-saas-catalog="true"]')).toHaveCount(0);
  await expect(page.getByRole("heading", { name: PROTECTED_MARKER })).toHaveCount(0);
  await expect(page.getByText(RAW_DETAIL, { exact: false })).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText(/stack trace|upstream response|internal server/i);
}

async function expectFetchStartedAfterClear(page: Page): Promise<void> {
  const snapshot = await page.evaluate(() => (
    window as typeof window & { __signOutFetchSnapshot?: FetchSnapshot }
  ).__signOutFetchSnapshot);
  expect(snapshot).toEqual({ catalogMounted: false, markerVisible: false });
}

function deferred(): { promise: Promise<void>; release(): void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

test.describe("SaaS sign-out outcomes", () => {
  test.beforeAll(() => buildSaasClient());

  test("traps the confirmation dialog and restores trigger focus on cancel and Escape", async ({ browser }) => {
    const opened = await openAuthenticatedSaas(browser);
    try {
      const { page, signOutRequests } = opened;
      const trigger = page.getByRole("button", { name: "Sign out" });

      await trigger.click();
      const dialog = page.getByRole("dialog", { name: "Sign out on this device?" });
      const cancel = dialog.getByRole("button", { name: "Cancel" });
      const confirm = dialog.getByRole("button", { name: "Sign out" });
      await expect(dialog).toHaveAttribute("aria-modal", "true");
      await expect(cancel).toBeFocused();
      await page.keyboard.press("Shift+Tab");
      await expect(confirm).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(cancel).toBeFocused();
      await axeScan(page, "sign-out confirmation");

      await cancel.click();
      await expect(trigger).toBeFocused();
      await expect(page.getByRole("heading", { name: PROTECTED_MARKER })).toBeVisible();

      await trigger.click();
      await expect(cancel).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(trigger).toBeFocused();
      await expect(page.getByRole("heading", { name: PROTECTED_MARKER })).toBeVisible();
      expect(signOutRequests.count).toBe(0);
    } finally {
      await closeSaas(opened.context, opened.harness);
    }
  });

  test("clears content before transport, suppresses duplicate submits, and completes a 204 sign-out", async ({ browser }) => {
    const responseGate = deferred();
    const opened = await openAuthenticatedSaas(browser, {
      signOut: async (route) => {
        await responseGate.promise;
        await route.fulfill({ status: 204 }).catch(() => undefined);
      },
    });
    try {
      const { page, signOutRequests } = opened;
      await page.getByRole("button", { name: "Sign out" }).click();
      const confirm = page.getByRole("dialog").getByRole("button", { name: "Sign out" });
      await confirm.evaluate((button: HTMLButtonElement) => {
        button.click();
        button.click();
      });

      await expect.poll(() => signOutRequests.count).toBe(1);
      const pendingDialog = page.getByRole("dialog", { name: "Signing out…" });
      await expect(pendingDialog).toHaveAttribute("aria-busy", "true");
      await expect(page.locator("main[data-session-boundary]")).toHaveAttribute("aria-busy", "true");
      const pendingStatus = pendingDialog.getByRole("status");
      await expect(pendingStatus).toHaveAttribute("aria-live", "polite");
      await expect(page.getByRole("heading", { name: "Signing out…" })).toBeFocused();
      await expectProtectedContentCleared(page);
      await expectFetchStartedAfterClear(page);
      await axeScan(page, "sign-out pending");

      responseGate.release();
      const signedOut = page.getByRole("status");
      await expect(signedOut).toContainText("You’re signed out");
      await expect(signedOut).toHaveAttribute("aria-live", "polite");
      await expect(page.getByRole("heading", { name: "You’re signed out" })).toBeFocused();
      await expect(page.getByRole("button", { name: "Sign in again" })).toBeEnabled();
      await expectProtectedContentCleared(page);
      expect(signOutRequests.count).toBe(1);
      await axeScan(page, "sign-out success");
    } finally {
      responseGate.release();
      await closeSaas(opened.context, opened.harness);
    }
  });

  for (const failure of ["timeout", "network", "server"] as const) {
    test(`maps ${failure} failure to the same focused, retryable, redacted state`, async ({ browser }) => {
      test.setTimeout(20_000);
      const timeoutGate = deferred();
      const opened = await openAuthenticatedSaas(browser, {
        signOut: async (route) => {
          if (failure === "timeout") {
            await timeoutGate.promise;
            await fulfillJson(route, 503, { error: RAW_DETAIL }).catch(() => undefined);
          } else if (failure === "network") {
            await route.abort("connectionfailed");
          } else {
            await fulfillJson(route, 503, { error: RAW_DETAIL, stack: "stack trace" });
          }
        },
      });
      try {
        const { page, signOutRequests } = opened;
        await page.getByRole("button", { name: "Sign out" }).click();
        await page.getByRole("dialog").getByRole("button", { name: "Sign out" }).click();

        const failureAlert = page.getByRole("alert");
        await expect(failureAlert).toContainText("We couldn’t confirm sign-out", { timeout: 8_000 });
        await expect(page.getByRole("heading", { name: "We couldn’t confirm sign-out" })).toBeFocused();
        await expect(page.getByRole("button", { name: "Try sign-out again" })).toBeEnabled();
        await expectProtectedContentCleared(page);
        await expectFetchStartedAfterClear(page);
        expect(signOutRequests.count).toBe(1);
        await axeScan(page, `${failure} sign-out failure`);
      } finally {
        timeoutGate.release();
        await closeSaas(opened.context, opened.harness);
      }
    });
  }

  test("retries once from the unconfirmed state and recovers to signed out", async ({ browser }) => {
    const retryGate = deferred();
    const opened = await openAuthenticatedSaas(browser, {
      signOut: async (route, requestNumber) => {
        if (requestNumber === 1) {
          await fulfillJson(route, 503, { error: RAW_DETAIL });
          return;
        }
        await retryGate.promise;
        await route.fulfill({ status: 204 }).catch(() => undefined);
      },
    });
    try {
      const { page, signOutRequests } = opened;
      await page.getByRole("button", { name: "Sign out" }).click();
      await page.getByRole("dialog").getByRole("button", { name: "Sign out" }).click();
      await expect(page.getByRole("alert")).toContainText("We couldn’t confirm sign-out");
      await expectProtectedContentCleared(page);
      expect(signOutRequests.count).toBe(1);

      await page.getByRole("button", { name: "Try sign-out again" }).click();
      await expect.poll(() => signOutRequests.count).toBe(2);
      await expect(page.getByRole("dialog", { name: "Signing out…" })).toHaveAttribute("aria-busy", "true");
      await expect(page.getByRole("heading", { name: "Signing out…" })).toBeFocused();
      await expectProtectedContentCleared(page);
      await axeScan(page, "sign-out retry pending");

      retryGate.release();
      await expect(page.getByRole("status")).toContainText("You’re signed out");
      await expect(page.getByRole("heading", { name: "You’re signed out" })).toBeFocused();
      await expectProtectedContentCleared(page);
      expect(signOutRequests.count).toBe(2);
      await axeScan(page, "sign-out retry recovery");
    } finally {
      retryGate.release();
      await closeSaas(opened.context, opened.harness);
    }
  });
});
