import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test, type Browser, type BrowserContext, type Page } from "playwright/test";

import {
  bootHarness,
  FAKE_CLAUDE_CLI,
  FAKE_CODEX_CLI,
  type BootedHarness,
} from "../server/testing/harness.ts";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const BOT_NAME = "Smoke Agent";
const DRAFT = "Keep this draft while the connection recovers.";
const HYDRATION_PROMPT = "Persist this turn exactly once.";
const APPROVAL_BOT = "Approval Smoke Agent";
const APPROVAL_PROMPT = "Request the scripted risky command.";

function claudeHarness(): Promise<BootedHarness> {
  return bootHarness({
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
}

function approvalHarness(): Promise<BootedHarness> {
  return bootHarness({
    instances: {
      smoke: {
        driver: "codex",
        displayName: "Smoke Fake Codex",
        config: { cli: FAKE_CODEX_CLI, fullAuto: false },
      },
    },
    env: {
      FAKE_CODEX_MODE: "approval",
      OMB_STATIC_DIR: join(REPO, "dist"),
    },
  });
}

async function openApp(
  browser: Browser,
  harness: BootedHarness,
  options: { controlEventSource?: boolean } = {},
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    extraHTTPHeaders: { authorization: `Bearer ${harness.token}` },
  });
  if (options.controlEventSource) {
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
  }
  const page = await context.newPage();
  await page.goto(harness.base, { waitUntil: "domcontentloaded" });
  return { context, page };
}

async function completeOnboarding(page: Page, engineVersion: RegExp): Promise<void> {
  await expect(page.getByRole("heading", { name: "Welcome to VelarixBot" })).toBeVisible();
  await page.getByRole("button", { name: "Check local engines" }).click();
  await expect(page.getByRole("heading", { name: "Local engines" })).toBeVisible();
  await expect(page.getByText(engineVersion)).toBeVisible();
  await page.getByRole("button", { name: "Start using VelarixBot" }).click();
  await expect(page.getByPlaceholder("Message Chief of Staff")).toBeVisible();
}

async function createBot(page: Page, name: string): Promise<void> {
  await page.getByTitle("New bot").first().click();
  const createDialog = page.getByRole("dialog", { name: "Create a bot" });
  await createDialog.getByLabel("Name").fill(name);
  await createDialog.getByLabel("Title").fill("Deterministic release smoke");
  await createDialog.getByLabel("Description").fill("Exercises a local scripted fake engine only.");
  await createDialog.locator("[data-create-bot-confirm]").click();
  await expect(page.getByPlaceholder(`Message ${name}`)).toBeVisible();
}

test.describe("fake-engine primary workflow", () => {
  test("creates a bot, preserves an offline draft, reconnects, and completes a turn", async ({ browser }) => {
    test.setTimeout(90_000);
    const harness = await claudeHarness();
    const { context, page } = await openApp(browser, harness, { controlEventSource: true });

    try {
      await completeOnboarding(page, /Claude Code .* fake-claude 1\.0\.0/);
      await createBot(page, BOT_NAME);

      const onlineComposer = page.getByPlaceholder(`Message ${BOT_NAME}`);
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
      await harness.stop();
    }
  });

  test("hydrates one persisted bot and completed turn after a real server restart and page reload", async ({ browser }) => {
    test.setTimeout(90_000);
    const harness = await claudeHarness();
    const { context, page } = await openApp(browser, harness);

    try {
      await completeOnboarding(page, /Claude Code .* fake-claude 1\.0\.0/);
      await createBot(page, BOT_NAME);

      const composer = page.getByPlaceholder(`Message ${BOT_NAME}`);
      await composer.fill(HYDRATION_PROMPT);
      await composer.press("Enter");
      await expect(page.getByText(HYDRATION_PROMPT, { exact: true })).toHaveCount(1);
      await expect(page.getByText("hello from fake claude", { exact: true })).toHaveCount(1, { timeout: 20_000 });

      await harness.restart();
      await page.reload({ waitUntil: "domcontentloaded" });

      await expect(page.getByText(BOT_NAME, { exact: true }).first()).toBeVisible();
      await page.getByText(BOT_NAME, { exact: true }).first().click();
      await expect(page.getByPlaceholder(`Message ${BOT_NAME}`)).toBeVisible();
      await expect(page.getByText(HYDRATION_PROMPT, { exact: true })).toHaveCount(1);
      await expect(page.getByText("hello from fake claude", { exact: true })).toHaveCount(1);

      const snapshot = await harness.api("GET", "/api/events/snapshot");
      expect(snapshot.status).toBe(200);
      const bots = snapshot.body.bots as Array<{
        name: string;
        messages: Array<{ role: string; text?: string }>;
      }>;
      expect(bots.filter((bot) => bot.name === BOT_NAME)).toHaveLength(1);
      const restored = bots.find((bot) => bot.name === BOT_NAME);
      expect(restored?.messages.filter((message) => message.role === "user" && message.text === HYDRATION_PROMPT)).toHaveLength(1);
      expect(restored?.messages.filter((message) => message.role === "bot" && message.text === "hello from fake claude")).toHaveLength(1);
    } finally {
      await context.close();
      await harness.stop();
    }
  });

  test("shows a fake approval request and denies it once without persisting an allow rule", async ({ browser }) => {
    test.setTimeout(90_000);
    const harness = await approvalHarness();
    const { context, page } = await openApp(browser, harness);

    try {
      await completeOnboarding(page, /Codex .* fake-codex 0\.144\.4/);
      await createBot(page, APPROVAL_BOT);

      const composer = page.getByPlaceholder(`Message ${APPROVAL_BOT}`);
      await composer.fill(APPROVAL_PROMPT);
      await composer.press("Enter");

      await expect(page.getByText("Approval needed", { exact: true })).toBeVisible();
      await expect(page.getByText("rm -rf scratch", { exact: true })).toBeVisible();
      const deny = page.getByRole("button", { name: /Deny$/ });
      await expect(deny).toBeEnabled();
      await deny.click();
      await expect(deny).toBeDisabled();
      await expect(page.getByRole("main").getByText("done from fake codex", { exact: true })).toHaveCount(1, {
        timeout: 20_000,
      });

      const snapshot = await harness.api("GET", "/api/events/snapshot");
      const bot = (
        snapshot.body.bots as Array<{
          id: string;
          name: string;
          messages: Array<{ role: string; text?: string }>;
        }>
      ).find((candidate) => candidate.name === APPROVAL_BOT);
      expect(bot).toBeTruthy();
      expect(bot?.messages.filter((message) => message.role === "user" && message.text === APPROVAL_PROMPT)).toHaveLength(1);
      expect(bot?.messages.filter((message) => message.role === "bot" && message.text === "done from fake codex")).toHaveLength(1);
      const rules = await harness.api("GET", `/api/bots/${bot!.id}/approvals`);
      expect(rules.status).toBe(200);
      expect(rules.body.rules).toEqual([]);
    } finally {
      await context.close();
      await harness.stop();
    }
  });
});
