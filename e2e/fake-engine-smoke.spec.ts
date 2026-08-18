import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "playwright/test";

import { bootHarness, FAKE_CLAUDE_CLI, type BootedHarness } from "../server/testing/harness.ts";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const BOT_NAME = "Smoke Agent";
const DRAFT = "Keep this draft while the connection recovers.";

let harness: BootedHarness;

test.describe("fake-engine primary workflow", () => {
  test.beforeAll(async () => {
    harness = await bootHarness({
      instances: {
        smoke: {
          driver: "claudeAgent",
          displayName: "Smoke Fake Claude",
          config: { cli: FAKE_CLAUDE_CLI, permissionMode: "bypassPermissions" },
        },
      },
      env: {
        FAKE_CLAUDE_MODE: "stream",
        OMB_STATIC_DIR: join(REPO, "dist"),
      },
    });
  });

  test.afterAll(async () => {
    await harness?.stop();
  });

  test("creates a bot, preserves an offline draft, reconnects, and completes a turn", async ({ browser }) => {
    test.setTimeout(90_000);

    const context = await browser.newContext({
      extraHTTPHeaders: { authorization: `Bearer ${harness.token}` },
    });
    await context.addInitScript(() => {
      const NativeEventSource = window.EventSource;
      class ControlledEventSource extends NativeEventSource {
        constructor(url: string | URL, init?: EventSourceInit) {
          super(url, init);
          (window as typeof window & { __smokeEventSource?: EventSource }).__smokeEventSource = this;
        }
      }
      Object.defineProperty(window, "EventSource", { configurable: true, value: ControlledEventSource });
    });
    const page = await context.newPage();

    try {
      await page.goto(harness.base, { waitUntil: "domcontentloaded" });

      await expect(page.getByRole("heading", { name: "Welcome to VelarixBot" })).toBeVisible();
      await page.getByRole("button", { name: "Check local engines" }).click();
      await expect(page.getByRole("heading", { name: "Local engines" })).toBeVisible();
      await expect(page.getByText("Claude Code · fake-claude 1.0.0")).toBeVisible();
      await page.getByRole("button", { name: "Start using VelarixBot" }).click();

      await expect(page.getByPlaceholder("Message Chief of Staff")).toBeVisible();
      await page.getByTitle("New bot").first().click();
      const createDialog = page.getByRole("dialog", { name: "Create a bot" });
      await createDialog.getByLabel("Name").fill(BOT_NAME);
      await createDialog.getByLabel("Title").fill("Deterministic release smoke");
      await createDialog.getByLabel("Description").fill("Exercises the local scripted fake engine only.");
      await createDialog.locator("[data-create-bot-confirm]").click();

      const onlineComposer = page.getByPlaceholder(`Message ${BOT_NAME}`);
      await expect(onlineComposer).toBeVisible();

      await page.evaluate(() => {
        const stream = (window as typeof window & { __smokeEventSource?: EventSource }).__smokeEventSource;
        if (!stream) throw new Error("smoke EventSource was not captured");
        stream.dispatchEvent(new Event("error"));
      });
      const connectionStatus = page.getByRole("status");
      await expect(connectionStatus).toContainText("Connection lost. Reconnecting");

      const offlineComposer = page.getByPlaceholder(`Draft a message for ${BOT_NAME} — reconnecting to send`);
      await offlineComposer.fill(DRAFT);
      await offlineComposer.press("Enter");
      await expect(offlineComposer).toHaveValue(DRAFT);
      await expect(page.getByText(DRAFT, { exact: true })).toHaveCount(0);

      await page.evaluate(() => {
        const stream = (window as typeof window & { __smokeEventSource?: EventSource }).__smokeEventSource;
        if (!stream) throw new Error("smoke EventSource was not captured");
        stream.dispatchEvent(new Event("open"));
      });
      await expect(connectionStatus).toBeHidden({ timeout: 15_000 });
      await expect(onlineComposer).toHaveValue(DRAFT);
      await onlineComposer.press("Enter");

      await expect(onlineComposer).toHaveValue("");
      await expect(page.getByText(DRAFT, { exact: true })).toBeVisible();
      await expect(page.getByText("hello from fake claude", { exact: true }).last()).toBeVisible({ timeout: 20_000 });
      await expect(page.getByText("SUBAGENT NOISE", { exact: true })).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
});
