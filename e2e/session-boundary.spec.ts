import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test, type Browser, type BrowserContext, type Page } from "playwright/test";

import { bootHarness, type BootedHarness } from "../server/testing/harness.ts";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const VITE_CLI = join(REPO, "node_modules", "vite", "bin", "vite.js");
const PROTECTED_PATH = /^\/api\/(?:instances|config|routines|events|bots|groups|approvals|computers|workspaces)(?:\/|$)/;

function buildClient(mode: string): void {
  execFileSync(process.execPath, [VITE_CLI, "build", "--logLevel", "warn"], {
    cwd: REPO,
    env: { ...process.env, VITE_VELARIX_APP_MODE: mode },
    stdio: "pipe",
  });
}

async function openBuiltClient(
  browser: Browser,
  options: { session?: "authenticated" },
): Promise<{ context: BrowserContext; harness: BootedHarness; page: Page; apiPaths: string[] }> {
  const harness = await bootHarness({
    instances: {},
    env: { OMB_STATIC_DIR: join(REPO, "dist") },
  });
  const context = await browser.newContext({
    extraHTTPHeaders: { authorization: `Bearer ${harness.token}` },
  });
  const apiPaths: string[] = [];
  context.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin === harness.base && url.pathname.startsWith("/api/")) apiPaths.push(url.pathname);
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
  if (options.session === "authenticated") {
    await context.route(`${harness.base}/api/session`, (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ user: { id: "123e4567-e89b-42d3-a456-426614174000" } }),
    }));
  }
  const page = await context.newPage();
  await page.goto(harness.base, { waitUntil: "domcontentloaded" });
  return { context, harness, page, apiPaths };
}

async function closeBuiltClient(context: BrowserContext, harness: BootedHarness): Promise<void> {
  await context.close();
  await harness.stop();
}

test.describe.serial("built fail-closed session boundary", () => {
  test("exact saas mode mounts only the boundary and restores sign-out focus", async ({ browser }) => {
    buildClient("saas");
    const { context, harness, page, apiPaths } = await openBuiltClient(browser, { session: "authenticated" });
    try {
      await expect(page.getByRole("heading", { name: "Signed in" })).toBeVisible();
      await expect(page.locator('[data-session-boundary="true"]')).toBeVisible();
      await expect(page.getByText("Product access is not enabled yet.")).toBeVisible();

      const signOut = page.getByRole("button", { name: "Sign out" });
      await signOut.click();
      await expect(page.getByRole("dialog", { name: "Sign out on this device?" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Cancel" })).toBeFocused();
      await page.getByRole("button", { name: "Cancel" }).click();
      await expect(signOut).toBeFocused();

      await signOut.click();
      await expect(page.getByRole("button", { name: "Cancel" })).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(signOut).toBeFocused();

      expect(apiPaths.length).toBeGreaterThan(0);
      expect(new Set(apiPaths)).toEqual(new Set(["/api/session"]));
      expect(apiPaths.some((path) => PROTECTED_PATH.test(path))).toBe(false);
      expect(await page.evaluate(() => Boolean(
        (window as typeof window & { __desktopContentFlashed?: boolean }).__desktopContentFlashed,
      ))).toBe(false);
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
});
