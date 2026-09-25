import { dirname, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test, type Page, type Browser } from "playwright/test";
import { bootHarness } from "../server/testing/harness.ts";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
test.beforeAll(() => {
  if (process.env.UI_BUILD_DIR) return;
  execFileSync(process.execPath, [resolve(REPO, "node_modules/vite/bin/vite.js"), "build", "--logLevel", "warn"], {
    cwd: REPO, env: { ...process.env, VITE_VELARIX_APP_MODE: "desktop" }, stdio: "pipe",
  });
});

if (process.env.VELARIX_PLAYWRIGHT_CHANNEL) test.use({ channel: process.env.VELARIX_PLAYWRIGHT_CHANNEL });
const bot = (id: string, name: string) => ({
  id, threadId: `thread-${id}`, name, title: "Research assistant", description: "", notifications: false,
  color: "green", unread: false, busy: false, state: "IDLE", usage: { input: 0, output: 0, cost: null },
  modelSelection: { instanceId: "fake", model: "fake" }, messages: [] as any[], hasMore: false, computer: "box",
});

async function emit(page: Page, frame: unknown) {
  await page.evaluate((frame) => (window as any).__emitFrame(frame), frame);
}

async function fixture(browser: Browser) {
  const harness = await bootHarness({ instances: {}, env: { OMB_STATIC_DIR: resolve(REPO, process.env.UI_BUILD_DIR ?? "dist") } });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, extraHTTPHeaders: { authorization: `Bearer ${harness.token}` } });
  const bots = [bot("alpha", "Alpha"), bot("beta", "Beta")];
  await context.addInitScript(() => {
    localStorage.setItem("velarixbot:onboarding-complete:v1", "true");
    class FakeEventSource {
      onopen: null | (() => void) = null;
      onmessage: null | ((event: { data: string }) => void) = null;
      onerror = null;
      constructor() {
        (window as any).__emitFrame = (frame: unknown) => this.onmessage?.({ data: JSON.stringify(frame) });
        queueMicrotask(() => this.onopen?.());
      }
      close() {}
    }
    (window as any).EventSource = FakeEventSource;
  });
  await context.route("**/api/events/snapshot*", (route) => route.fulfill({ json: { bots, groups: [], tasks: [], sequence: 0, streamId: "fixture" } }));
  const page = await context.newPage();
  return { page, bots, context, async open() { await page.goto(harness.base); await expect(page.getByPlaceholder("Message Alpha")).toBeVisible(); }, async close() { await context.close(); await harness.stop(); } };
}

const pickerInstances = [
  { instanceId: "missing", driverKind: "grok", displayName: "Grok", snapshot: { state: "unavailable", reason: "grok CLI not found" }, models: { default: "grok-default", options: [{ id: "grok-default", label: "Grok Default" }] } },
  { instanceId: "ready", driverKind: "codex", displayName: "Codex", snapshot: { state: "available", version: "Test engine" }, models: { default: "codex-one", options: Array.from({ length: 20 }, (_, i) => ({ id: i === 0 ? "codex-one" : `codex-${i + 1}`, label: i === 0 ? "Codex One" : `Codex ${i + 1}` })) } },
];

test("live-test review screenshots", async ({ browser }) => {
  const f = await fixture(browser);
  await f.context.route("**/api/instances", (route) => route.fulfill({ json: { instances: pickerInstances } }));
  try {
    Object.assign(f.bots[0], { state: "DONE", workflowStatus: "completed", workflowStopReason: "Full-autonomy is off — send a message to continue." });
    f.bots[0].messages.push({ id: "two-lines", role: "bot", kind: "text", text: "ORBIT-731\n323", at: Date.UTC(2026, 8, 25, 12) });
    await f.open();
    if (process.env.LIVE_UI_SCREENSHOT_DIR) {
      mkdirSync(process.env.LIVE_UI_SCREENSHOT_DIR, { recursive: true });
      await f.page.screenshot({ path: resolve(process.env.LIVE_UI_SCREENSHOT_DIR, "chat.png"), animations: "disabled" });
    }
    await f.page.getByTitle("New bot").first().click();
    const dialog = f.page.getByRole("dialog", { name: "Create a bot" });
    await dialog.getByLabel("Name", { exact: true }).fill("Ready to help");
    await dialog.getByText(/^(Grok Default|Codex One)$/, { exact: true }).click();
    if (process.env.LIVE_UI_SCREENSHOT_DIR) {
      await f.page.screenshot({ path: resolve(process.env.LIVE_UI_SCREENSHOT_DIR, "picker.png"), animations: "disabled" });
    }
  } finally { await f.close(); }
});

test("defaults to an available engine and keeps the model menu inside a short viewport", async ({ browser }) => {
  const f = await fixture(browser);
  await f.context.route("**/api/instances", (route) => route.fulfill({ json: { instances: pickerInstances } }));
  try {
    await f.page.setViewportSize({ width: 900, height: 600 });
    await f.open();
    await f.page.getByTitle("New bot").first().click();
    const dialog = f.page.getByRole("dialog", { name: "Create a bot" });
    await expect(dialog.getByRole("button", { name: "Choose model" })).toHaveText("Codex One");
    await dialog.getByRole("button", { name: "Choose model" }).click();
    const menu = f.page.locator("[data-model-picker-content]");
    await expect(menu).toBeVisible();
    const box = (await menu.boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(600);
    await menu.getByRole("button", { name: "Codex 20", exact: true }).click();
    await expect(dialog.getByRole("button", { name: "Choose model" })).toHaveText("Codex 20");
    await dialog.getByRole("button", { name: "Choose model" }).click();
    await f.page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(dialog).toBeVisible();
  } finally { await f.close(); }
});

test("keeps chat line breaks and starts a new timer without a stale completion banner", async ({ browser }) => {
  const f = await fixture(browser);
  await f.context.route("**/api/bots/alpha/messages", (route) => route.fulfill({ status: 202, json: { ok: true } }));
  try {
    Object.assign(f.bots[0], { state: "DONE", workflowStatus: "completed", workflowStopReason: "Full-autonomy is off — send a message to continue." });
    f.bots[0].messages.push({ id: "old", role: "user", kind: "text", text: "Earlier prompt", at: Date.now() - 120_000 });
    f.bots[0].messages.push({ id: "answer", role: "bot", kind: "text", text: "ORBIT-731\n323\n\n- First\n- Second\n\n```text\none\ntwo\n```", at: Date.now() - 119_000 });
    await f.open();
    await expect(f.page.getByText("Autonomous execution stopped", { exact: true })).toHaveCount(0);
    const paragraph = f.page.locator(".chat-md p").filter({ hasText: "ORBIT-731" });
    await expect(paragraph).toHaveCSS("white-space", "pre-wrap");
    await expect(f.page.locator(".chat-md li")).toHaveCount(2);
    await expect(f.page.locator(".chat-md pre")).toContainText("one\ntwo");
    await f.page.getByPlaceholder("Message Alpha").fill("A new turn");
    await f.page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(f.page.getByTestId("run-inspector-pill")).toHaveText(/Working for [0-9]s/);
    await expect(f.page.getByText("Full-autonomy is off — send a message to continue.", { exact: true })).toHaveCount(0);
  } finally { await f.close(); }
});

test("review screenshot", async ({ browser }) => {
  const f = await fixture(browser);
  try {
    f.bots[0].messages.push({ id: "intro", role: "bot", kind: "text", text: "Send me the source files and I’ll prepare a reviewable summary.", at: Date.UTC(2026, 8, 25, 9) });
    await f.open();
    await f.page.getByPlaceholder("Message Alpha").fill("Review the attached report.\nSummarize the risks and cite each source.");
    if (process.env.UI_SCREENSHOT) {
      mkdirSync(dirname(process.env.UI_SCREENSHOT), { recursive: true });
      await f.page.screenshot({ path: process.env.UI_SCREENSHOT, animations: "disabled" });
    }
  } finally { await f.close(); }
});

test("keeps separate multiline drafts across bot switches and reloads", async ({ browser }) => {
  const f = await fixture(browser);
  try {
    await f.open();
    const input = f.page.getByRole("textbox", { name: "Message Alpha", exact: true });
    await input.fill("Alpha first line");
    await input.press("Shift+Enter");
    await input.pressSequentially("Second line");
    await f.page.getByText("Beta", { exact: true }).first().click();
    await expect(f.page.getByRole("textbox", { name: "Message Beta", exact: true })).toHaveValue("");
    await f.page.getByRole("textbox", { name: "Message Beta", exact: true }).fill("Beta draft");
    await f.page.getByText("Alpha", { exact: true }).first().click();
    await expect(input).toHaveValue("Alpha first line\nSecond line");
    await f.page.reload();
    await expect(input).toHaveValue("Alpha first line\nSecond line");
    await input.dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: true });
    await expect(input).toHaveValue("Alpha first line\nSecond line");
  } finally { await f.close(); }
});

test("retains failed sends and retries with the same idempotency key", async ({ browser }) => {
  const f = await fixture(browser);
  const posts: any[] = [];
  await f.context.route("**/api/bots/alpha/messages", async (route) => {
    posts.push(route.request().postDataJSON());
    await route.fulfill({ status: posts.length === 1 ? 503 : 202, json: posts.length === 1 ? { error: "Temporarily unavailable" } : { ok: true } });
  });
  try {
    await f.open();
    await f.page.getByRole("textbox", { name: "Message Alpha", exact: true }).fill("Keep this submission");
    await f.page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(f.page.getByRole("alert")).toContainText("Temporarily unavailable");
    await expect(f.page.getByText("Keep this submission", { exact: true })).toBeVisible();
    await f.page.getByRole("button", { name: "Retry", exact: true }).click();
    await expect.poll(() => posts.length).toBe(2);
    expect(posts[0].idempotencyKey).toBeTruthy();
    expect(posts[1]).toEqual(posts[0]);
    await expect(f.page.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
  } finally { await f.close(); }
});

test("Stop pauses follow-ups until Resume, including after reload", async ({ browser }) => {
  const f = await fixture(browser);
  let posts = 0;
  await f.context.route("**/api/bots/alpha/messages", (route) => { posts++; return route.fulfill({ status: 202, json: { ok: true } }); });
  await f.context.route("**/api/bots/alpha/interrupt", async (route) => { await route.fulfill({ json: { ok: true } }); await emit(f.page, { kind: "bot", bot: { id: "alpha", busy: false, state: "BLOCKED" } }); });
  try {
    await f.open();
    await emit(f.page, { kind: "bot", bot: { id: "alpha", busy: true, state: "RUNNING" } });
    await f.page.getByRole("textbox", { name: "Message Alpha", exact: true }).fill("Wait for my resume");
    await f.page.getByRole("button", { name: "Queue message", exact: true }).click();
    await f.page.getByTitle("Stop this turn").click();
    await expect(f.page.getByText("Queued messages paused")).toBeVisible();
    expect(posts).toBe(0);
    await f.page.reload();
    await expect(f.page.getByText("Queued messages paused")).toBeVisible();
    expect(posts).toBe(0);
    await f.page.getByRole("button", { name: "Resume queue" }).click();
    await expect.poll(() => posts).toBe(1);
  } finally { await f.close(); }
});

test("pasted attachments survive switching bots and a failed message can be edited", async ({ browser }) => {
  const f = await fixture(browser);
  const posts: any[] = [];
  await f.context.addInitScript(() => {
    (window as any).ogb = {
      platform: "win32", attachmentPath: () => "",
      saveClipboardImage: async ({ bytes }: { bytes: Uint8Array }) => {
        if (!bytes.length) throw new Error("Empty image");
        return { path: "C:\\attachments\\clipboard.png", name: "Pasted image.png" };
      },
    };
  });
  await f.context.route("**/api/bots/alpha/messages", (route) => {
    posts.push(route.request().postDataJSON());
    return route.fulfill({ status: 400, json: { error: "Reattach this image" } });
  });
  try {
    await f.open();
    const input = f.page.getByRole("textbox", { name: "Message Alpha", exact: true });
    await input.fill("Review this image");
    await input.evaluate((element) => {
      const data = new DataTransfer();
      data.items.add(new File([new Uint8Array([137, 80, 78, 71])], "image.png", { type: "image/png" }));
      element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true }));
    });
    await expect(f.page.getByText("Pasted image.png", { exact: true })).toBeVisible();
    await f.page.getByText("Beta", { exact: true }).first().click();
    await expect(f.page.getByText("Pasted image.png", { exact: true })).toHaveCount(0);
    await f.page.getByText("Alpha", { exact: true }).first().click();
    await expect(f.page.getByText("Pasted image.png", { exact: true })).toBeVisible();
    await f.page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(f.page.getByRole("alert")).toContainText("Reattach this image");
    expect(posts[0].attachments).toEqual([{ path: "C:\\attachments\\clipboard.png", mime: "image/png" }]);
    await f.page.getByRole("button", { name: "Edit", exact: true }).click();
    await expect(input).toHaveValue("Review this image");
    await expect(f.page.getByText("clipboard.png", { exact: true })).toBeVisible();
    await expect(f.page.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
  } finally { await f.close(); }
});

test("stalled live screenshots fall back to polling while the bot is still busy", async ({ browser }) => {
  const f = await fixture(browser);
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";
  let screenshots = 0;
  await f.context.route("**/api/bots/alpha/computer", (route) => route.fulfill({ json: { configured: true, box: "test" } }));
  await f.context.route("**/api/bots/alpha/computer/provision", (route) => route.fulfill({ json: { state: "running" } }));
  await f.context.route("**/api/bots/alpha/computer/screenshot", (route) => {
    screenshots++;
    return route.fulfill({ json: { png, format: "png" } });
  });
  try {
    await f.open();
    await f.page.clock.install();
    await f.page.getByTitle("Bot's computer").click();
    const preview = f.page.getByRole("img", { name: "Alpha's screen", exact: true });
    await expect(preview).toHaveAttribute("src", `data:image/png;base64,${png}`);
    await emit(f.page, { kind: "bot", bot: { id: "alpha", busy: true, state: "RUNNING" } });
    await f.page.clock.runFor(100);
    // Base64 whitespace keeps the image valid while distinguishing the live frame.
    await emit(f.page, { kind: "screen", botId: "alpha", png: `${png}\n`, mime: "image/png" });
    await expect(preview).toHaveAttribute("src", `data:image/png;base64,${png}\n`);
    const before = screenshots;
    await f.page.clock.runFor(4000);
    expect(screenshots).toBe(before);
    await f.page.clock.runFor(3000);
    await expect.poll(() => screenshots).toBeGreaterThan(before);
    await expect(preview).toHaveAttribute("src", `data:image/png;base64,${png}`);
    await expect(f.page.getByText(/Last updated/)).toBeVisible();
  } finally { await f.close(); }
});

test("bot creation failure retains the form and supports retry", async ({ browser }) => {
  const f = await fixture(browser);
  let attempts = 0;
  await f.context.route("**/api/bots", (route) => {
    if (route.request().method() !== "POST") return route.continue();
    attempts++;
    return route.fulfill({ status: attempts === 1 ? 503 : 201, json: attempts === 1 ? { error: "Please retry" } : { bot: bot("gamma", "Gamma") } });
  });
  try {
    await f.open();
    await f.page.getByTitle("New bot").first().click();
    const dialog = f.page.getByRole("dialog", { name: "Create a bot" });
    await dialog.getByLabel("Name", { exact: true }).fill("Gamma");
    await dialog.locator("[data-create-bot-confirm]").click();
    await expect(dialog.getByRole("alert")).toContainText("Couldn’t create this bot");
    await expect(dialog.getByLabel("Name", { exact: true })).toHaveValue("Gamma");
    await dialog.locator("[data-create-bot-confirm]").click();
    await expect(f.page.getByRole("textbox", { name: "Message Gamma", exact: true })).toBeVisible();
  } finally { await f.close(); }
});

test("pages long history without rendering more than one window", async ({ browser }) => {
  const f = await fixture(browser);
  const messages = Array.from({ length: 10000 }, (_, i) => ({ id: `m-${i}`, role: "user", kind: "text", text: `History message ${i}`, at: i + 1 }));
  f.bots[0].messages = messages.slice(-50);
  f.bots[0].hasMore = true;
  await f.context.route("**/api/threads/thread-alpha/messages?*", (route) => {
    const before = Number(new URL(route.request().url()).searchParams.get("before")!.slice(2));
    return route.fulfill({ json: { messages: messages.slice(Math.max(0, before - 100), before), hasMore: before > 100 } });
  });
  try {
    await f.open();
    await expect(f.page.locator("main").getByText(/^History message /)).toHaveCount(50);
    await f.page.getByRole("button", { name: "Show earlier messages" }).click();
    await expect(f.page.locator("main").getByText(/^History message /)).toHaveCount(150);
    await f.page.getByRole("button", { name: "Show earlier messages" }).click();
    await expect(f.page.getByText("History message 9750", { exact: true })).toBeVisible();
    await expect(f.page.locator("main").getByText(/^History message /)).toHaveCount(150);
    await f.page.getByRole("button", { name: "Jump to latest" }).click();
    await expect(f.page.locator("main").getByText("History message 9999", { exact: true })).toBeVisible();
  } finally { await f.close(); }
});

test("a failed engine check offers retry instead of reporting missing engines", async ({ browser }) => {
  const f = await fixture(browser);
  let fail = true;
  await f.context.addInitScript(() => localStorage.removeItem("velarixbot:onboarding-complete:v1"));
  await f.context.route("**/api/instances", (route) => route.fulfill({ status: fail ? 503 : 200, json: fail ? { error: "unavailable" } : { instances: [] } }));
  try {
    // open() waits for the composer behind the onboarding overlay.
    await f.open();
    await f.page.getByRole("button", { name: "Check local engines" }).click();
    await expect(f.page.getByRole("alert")).toContainText("Couldn’t check local engines");
    await expect(f.page.getByText("Not found", { exact: false })).toHaveCount(0);
    fail = false;
    await f.page.getByRole("button", { name: "Retry engine check" }).click();
    await expect(f.page.getByRole("alert")).toHaveCount(0);
    await expect(f.page.getByRole("button", { name: "Start using VelarixBot" })).toBeVisible();
  } finally { await f.close(); }
});

test("run history distinguishes request failure from an empty history", async ({ browser }) => {
  const f = await fixture(browser);
  let fail = true;
  await f.context.route("**/api/routines", (route) => route.fulfill({ json: { routines: [{ id: "routine", botId: "alpha", name: "Morning briefing", prompt: "Summarize", schedule: { kind: "interval", everyMinutes: 60 }, enabled: false, createdAt: 1, updatedAt: 1 }] } }));
  await f.context.route("**/api/routines/routine/runs", (route) => route.fulfill({ status: fail ? 503 : 200, json: fail ? { error: "unavailable" } : { runs: [] } }));
  try {
    await f.open();
    await f.page.getByRole("button", { name: "Routines", exact: true }).click();
    await f.page.getByRole("button", { name: "Show run history" }).click();
    await expect(f.page.getByRole("alert")).toContainText("Couldn’t load run history");
    await expect(f.page.getByText("No runs yet.")).toHaveCount(0);
    fail = false;
    await f.page.getByRole("button", { name: "Retry history" }).click();
    await expect(f.page.getByText("No runs yet.")).toBeVisible();
  } finally { await f.close(); }
});
