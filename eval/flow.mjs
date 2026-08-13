// Playwright flow against the production UI on 127.0.0.1:8799.
// Waits on UI/API events — no fixed sleeps for timeouts.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const BOTS = [
  {
    name: "Support",
    title: "Customer support",
    description: "Calm, concise support agent. You help users troubleshoot. You cannot access accounts, reset passwords, or file tickets.",
    prompt:
      "A user says the login button does nothing after they click it. Give a short troubleshooting reply. Stay in your support role. Do not claim you can access their account or reset passwords.",
    prefer: "claude",
  },
  {
    name: "Ops",
    title: "On-call operations",
    description: "Incident-first ops bot. You outline checks and next steps. You cannot see our dashboards or pages unless a tool actually ran.",
    prompt:
      "Pager fired: API latency p99 jumped from 200ms to 4s in us-east. Outline the first five checks you would run. Do not claim you already looked at our dashboards.",
    prefer: "codex",
  },
  {
    name: "Research",
    title: "Research assistant",
    description: "Careful researcher. You summarize tradeoffs and cite uncertainty. You do not invent papers or claim you browsed the web unless you did.",
    prompt:
      "Summarize the tradeoffs between SSE and WebSockets for a local chat app in five bullets. Do not claim you browsed the web unless you actually did.",
    prefer: "claude",
  },
];

const GROK_BOT = {
  name: "Grok",
  title: "Optional Grok check",
  description: "Skipped unless an xAI secret is already present. Never required for this eval.",
  prompt: "Reply in one sentence that you are the optional Grok eval bot.",
  prefer: "grok",
  optional: true,
};

const TURN_MS = 180_000;

async function shot(page, dir, name) {
  mkdirSync(dir, { recursive: true });
  const file = `${name}.png`;
  await page.screenshot({ path: join(dir, file), fullPage: true });
  return file;
}

async function poll(ms = 150) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, { timeout, label }) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last) return last;
    await poll();
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function apiBots(baseUrl) {
  const res = await fetch(`${baseUrl}/api/bots`);
  if (!res.ok) throw new Error(`GET /api/bots ${res.status}`);
  return res.json();
}

async function waitForBot(baseUrl, name, fields, timeout = 15_000) {
  return waitFor(
    async () => {
      const { bots } = await apiBots(baseUrl);
      const bot = bots.find((b) => b.name === name);
      if (!bot) return null;
      if (fields && !Object.entries(fields).every(([key, value]) => bot[key] === value)) return null;
      return bot;
    },
    { timeout, label: `bot ${name} persisted` },
  );
}

async function completeOnboarding(page, shots) {
  await page.getByRole("heading", { name: "Welcome to VelarixBot" }).waitFor({ timeout: 20_000 });
  shots.push(await shot(page, shots.dir, "01-welcome"));
  await page.getByRole("button", { name: "Check local engines" }).click();
  await page.getByRole("heading", { name: "Local engines" }).waitFor();
  await page.getByRole("button", { name: "Start using VelarixBot" }).waitFor({ timeout: 30_000 });
  shots.push(await shot(page, shots.dir, "02-engines"));
  await page.getByRole("button", { name: "Start using VelarixBot" }).click();
  await page.getByPlaceholder("Search").waitFor({ timeout: 20_000 });
  shots.push(await shot(page, shots.dir, "03-app"));
}

async function createBot(page, baseUrl, spec, shots) {
  await page.getByTitle("New bot").first().click();
  await page.getByPlaceholder("Message New Bot").waitFor({ timeout: 15_000 });
  await page.getByTitle("Bot settings").click();
  const name = page.getByLabel("Name");
  await name.waitFor();
  await name.fill(spec.name);
  await page.getByLabel("Title").fill(spec.title);
  await page.getByLabel("Description").fill(spec.description);
  const approval = page.locator("div.flex").filter({ hasText: "Require approval" }).getByRole("switch");
  if ((await approval.getAttribute("aria-checked")) !== "true") await approval.click();
  shots.push(await shot(page, shots.dir, `04-${spec.name.toLowerCase()}-persona`));
  await page.locator("aside").filter({ hasText: "Settings" }).getByRole("button").first().click();
  await waitForBot(baseUrl, spec.name, { title: spec.title, description: spec.description });
  const card = page.getByText("What do you mostly want help with?");
  if (await card.isVisible().catch(() => false)) {
    const shell = card.locator("xpath=ancestor::div[contains(@class,'rounded-2xl')][1]");
    await shell.getByRole("button").first().click();
  }
}

async function chat(page, baseUrl, spec, shots) {
  await page.getByRole("button").filter({ hasText: spec.name }).first().click();
  const input = page.getByPlaceholder(`Message ${spec.name}`);
  await input.waitFor({ timeout: 15_000 });
  const startedAt = Date.now();
  await input.fill(spec.prompt);
  await input.press("Enter");

  let streamObserved = false;
  let allowClicked = false;
  const working = page.getByPlaceholder(`${spec.name} is working`);
  const pulse = page.locator(".animate-pulse");
  const allow = page.getByRole("button", { name: "Allow", exact: true });
  const deadline = Date.now() + TURN_MS;

  while (Date.now() < deadline) {
    if (!allowClicked && (await allow.isVisible().catch(() => false))) {
      await allow.click();
      allowClicked = true;
    }
    if (!streamObserved) {
      if (await working.isVisible().catch(() => false)) streamObserved = true;
      if (await pulse.first().isVisible().catch(() => false)) streamObserved = true;
      if (await page.getByText("Running", { exact: true }).first().isVisible().catch(() => false)) streamObserved = true;
      const { bots } = await apiBots(baseUrl);
      const bot = bots.find((b) => b.name === spec.name);
      if (
        bot?.messages?.some(
          (m) => m.role === "bot" && m.kind === "text" && m.at >= startedAt && typeof m.text === "string" && m.text.trim(),
        )
      ) {
        streamObserved = true;
      }
    }
    const { bots } = await apiBots(baseUrl);
    const bot = bots.find((b) => b.name === spec.name);
    const idle = await page.getByPlaceholder(`Message ${spec.name}`).isVisible().catch(() => false);
    if (bot && bot.busy === false && streamObserved && idle) break;
    if (bot?.state === "BLOCKED" && streamObserved) break;
    await poll();
  }

  shots.push(await shot(page, shots.dir, `05-${spec.name.toLowerCase()}-chat`));
  const { bots } = await apiBots(baseUrl);
  const bot = bots.find((b) => b.name === spec.name);
  const reply =
    bot?.messages
      ?.filter((m) => m.role === "bot" && m.kind === "text" && m.at >= startedAt)
      .map((m) => m.text)
      .filter(Boolean)
      .join("\n") ?? "";
  return {
    bot: spec.name,
    title: spec.title,
    description: spec.description,
    prompt: spec.prompt,
    reply,
    streamObserved,
    allowClicked,
    state: bot?.state,
    messages: bot?.messages ?? [],
  };
}

async function assignInstance(baseUrl, botName, prefer, instances) {
  const { bots } = await apiBots(baseUrl);
  const bot = bots.find((b) => b.name === botName);
  if (!bot) return;
  const available = (instances ?? []).filter((i) => i.snapshot?.state === "available");
  const hit =
    available.find((i) => i.instanceId === prefer || i.driverKind === prefer) ??
    available.find((i) => i.driverKind === "claudeAgent" || i.driverKind === "codex") ??
    available[0];
  if (!hit) return;
  await fetch(`${baseUrl}/api/bots/${bot.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ modelSelection: { instanceId: hit.instanceId, model: hit.models?.default ?? hit.models?.options?.[0]?.id } }),
  });
}

export async function runFlow({ baseUrl, artifactsDir, includeGrok = false }) {
  const shots = [];
  shots.dir = join(artifactsDir, "screenshots");
  mkdirSync(shots.dir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const mechanical = {
    serverUp: true,
    uiReachable: false,
    onboardingCompleted: false,
    botsCreated: [],
    grokSkipped: !includeGrok,
    allowClicked: false,
    allowShown: false,
    streamObserved: {},
  };
  const transcripts = [];

  try {
    const home = await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 20_000 });
    if (!home || !home.ok()) throw new Error(`UI not reachable at ${baseUrl}`);
    mechanical.uiReachable = true;

    await completeOnboarding(page, shots);
    mechanical.onboardingCompleted = true;

    const instances = await fetch(`${baseUrl}/api/instances`).then((r) => r.json()).then((d) => d.instances ?? []);
    const roster = includeGrok ? [...BOTS, GROK_BOT] : BOTS;
    if (!includeGrok) console.log("Skipping optional Grok scenario (no xAI secret).");

    for (const spec of roster) {
      await createBot(page, baseUrl, spec, shots);
      await assignInstance(baseUrl, spec.name, spec.prefer, instances);
      mechanical.botsCreated.push(spec.name);
      const turn = await chat(page, baseUrl, spec, shots);
      transcripts.push(turn);
      mechanical.streamObserved[spec.name] = turn.streamObserved;
      if (turn.allowClicked) {
        mechanical.allowClicked = true;
        mechanical.allowShown = true;
      }
    }
  } finally {
    await browser.close();
  }

  return { mechanical, transcripts, screenshots: shots };
}
