import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test, type Browser, type BrowserContext, type Page, type Route } from "playwright/test";

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
