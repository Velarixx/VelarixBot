// 2026-08-18 inspection batch — live headless harness: isolated HOME,
// no real CLIs, no keychain, bearer auth. Windows-safe (argv-only spawn).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SWITCH_MODEL_OPTION } from "./engine-setup.ts";
import { bootHarness, FAKE_ACP_CLI, type BootedHarness } from "./testing/harness.ts";

const MISSING = "/definitely-not-a-velarix-engine";

let h: BootedHarness;

beforeAll(async () => {
  h = await bootHarness({
    instances: {
      claude: { driver: "claudeAgent", displayName: "Claude", config: { cli: MISSING } },
      codex: { driver: "codex", displayName: "Codex", config: { cli: MISSING } },
      grok: { driver: "grokAgent", displayName: "Grok", config: { cli: MISSING } },
      gemini: { driver: "geminiAgent", displayName: "Gemini", config: { cli: MISSING } },
    },
  });
}, 30_000);

afterAll(async () => {
  await h?.stop();
});

describe("2026-08-18 inspection live harness (no CLIs, bearer auth)", () => {
  it("POST /api/bots honors name Scout (not New Bot) plus title/description/color", async () => {
    const created = await h.api("POST", "/api/bots", {
      name: "Scout",
      title: "Field scout",
      description: "Looks around",
      color: "green",
    });
    expect(created.status).toBe(201);
    expect(created.body.bot).toMatchObject({
      name: "Scout",
      title: "Field scout",
      description: "Looks around",
      color: "green",
    });
    expect(created.body.bot.name).not.toBe("New Bot");
  });

  it("a zero-engine turn is non-hanging, has no raw spawn_error, and appends a setup card", async () => {
    const created = await h.api("POST", "/api/bots", { name: "Probe" });
    const bot = created.body.bot;
    const send = await h.api("POST", `/api/bots/${bot.id}/messages`, { text: "hello?" });
    expect(send.status).toBe(202);
    expect(send.body.ok).toBe(true);
    expect(typeof send.body.threadId).toBe("string");
    expect(typeof send.body.messageId).toBe("string");

    const blocked = await h.sse.until(
      (f) => f.kind === "bot" && f.bot?.id === bot.id && f.bot?.state === "BLOCKED",
      15_000,
    );
    expect(blocked.bot?.stateDetail).toBeTruthy();
    expect(String(blocked.bot?.stateDetail)).not.toMatch(/spawn_error/i);
    expect(blocked.bot?.stateCode === "no_engines" || blocked.bot?.stateCode === "spawn_error" || blocked.bot?.stateCode === "engine_unavailable").toBe(true);
    expect(blocked.bot?.busy).toBe(false);

    const card = await h.sse.until(
      (f) =>
        f.kind === "message" &&
        f.threadId === bot.threadId &&
        f.message?.card?.requestType === "setup",
      15_000,
    );
    const options = card.message?.card?.options ?? [];
    expect(options.join("\n")).toMatch(/Claude/i);
    expect(options.join("\n")).toMatch(/Codex/i);
    expect(options.join("\n")).toMatch(/Grok/i);
    expect(options.join("\n")).toMatch(/Gemini/i);
  });

  it("keeps /api/health minimal (app/pid/static/stamp) and 404s /api/models", async () => {
    const health = await fetch(`${h.base}/api/health`);
    expect(health.status).toBe(200);
    const body = (await health.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["app", "pid", "stamp", "static"]);
    expect(body.app).toBe("velarixbot");

    const models = await h.api("GET", "/api/models");
    expect(models.status).toBe(404);
    const instances = await h.api("GET", "/api/instances");
    expect(instances.status).toBe(200);
    expect(Array.isArray(instances.body.instances)).toBe(true);
  });

  it("PATCH whitespace-only names are rejected; correlation ids match the SSE user message", async () => {
    const created = await h.api("POST", "/api/bots", { name: "Named" });
    const bot = created.body.bot;
    const blank = await h.api("PATCH", `/api/bots/${bot.id}`, { name: "   " });
    expect(blank.status).toBe(400);
    expect(blank.body.error).toMatch(/name/);
    const still = await h.api("GET", "/api/bots");
    expect(still.body.bots.find((b: { id: string }) => b.id === bot.id).name).toBe("Named");

    const send = await h.api("POST", `/api/bots/${bot.id}/messages`, { text: "correlate me" });
    expect(send.status).toBe(202);
    expect(send.body.ok).toBe(true);
    const frame = await h.sse.until(
      (f) => f.kind === "message" && f.message?.id === send.body.messageId,
      10_000,
    );
    expect(frame.threadId).toBe(send.body.threadId);
    expect(frame.message?.text).toBe("correlate me");
  });
});

describe("2026-08-18 clean-PATH live harness (bare CLI names, zero spawn)", () => {
  let h: BootedHarness;
  const emptyPath = mkdtempSync(join(tmpdir(), "omb-empty-path-"));

  beforeAll(async () => {
    h = await bootHarness({
      instances: {
        claude: { driver: "claudeAgent", displayName: "Claude", config: { cli: "claude" } },
        codex: { driver: "codex", displayName: "Codex", config: { cli: "codex" } },
        grok: { driver: "grokAgent", displayName: "Grok", config: { cli: "grok" } },
        gemini: { driver: "geminiAgent", displayName: "Gemini", config: { cli: "gemini" } },
      },
      env: { PATH: emptyPath, OMB_PATH_STRICT: "1" },
    });
  }, 30_000);

  afterAll(async () => {
    await h?.stop();
  });

  it("bare PATH names with a clean PATH block without spawning", async () => {
    const created = await h.api("POST", "/api/bots", { name: "CleanPath" });
    const bot = created.body.bot;
    const send = await h.api("POST", `/api/bots/${bot.id}/messages`, { text: "hello?" });
    expect(send.status).toBe(202);
    expect(send.body.ok).toBe(true);

    const blocked = await h.sse.until(
      (f) => f.kind === "bot" && f.bot?.id === bot.id && f.bot?.state === "BLOCKED",
      8_000,
    );
    expect(blocked.bot?.stateCode).toBe("no_engines");
    expect(String(blocked.bot?.stateDetail)).not.toMatch(/spawn_error/i);
    expect(String(blocked.bot?.stateDetail)).not.toMatch(/spawn failed/i);
    expect(blocked.bot?.busy).toBe(false);

    const spawned = h.sse.frames.some(
      (f) =>
        f.kind === "runtime" &&
        (f.event?.type === "runtime.error" || f.event?.type === "turn.started" || f.event?.type === "turn.completed"),
    );
    expect(spawned).toBe(false);

    const card = await h.sse.until(
      (f) =>
        f.kind === "message" &&
        f.threadId === bot.threadId &&
        f.message?.card?.requestType === "setup",
      8_000,
    );
    const options = card.message?.card?.options ?? [];
    expect(options.join("\n")).toMatch(/Claude/i);
    expect(options.join("\n")).toMatch(/Codex/i);
    expect(options.join("\n")).toMatch(/Grok/i);
    expect(options.join("\n")).toMatch(/Gemini/i);
    expect(options[0]).not.toBe(SWITCH_MODEL_OPTION);
  });
});

describe("2026-08-18 one-missing-engine live harness", () => {
  let h: BootedHarness;
  const emptyPath = mkdtempSync(join(tmpdir(), "omb-empty-path-"));

  beforeAll(async () => {
    h = await bootHarness({
      instances: {
        claude: { driver: "claudeAgent", displayName: "Claude", config: { cli: "claude" } },
        helper: { driver: "grokAgent", displayName: "Grok", config: { cli: FAKE_ACP_CLI } },
      },
      env: { PATH: emptyPath, OMB_PATH_STRICT: "1" },
    });
  }, 30_000);

  afterAll(async () => {
    await h?.stop();
  });

  it("selected missing CLI keeps the concrete reason and offers switch-model", async () => {
    const created = await h.api("POST", "/api/bots", { name: "OneMissing" });
    const bot = created.body.bot;
    const patched = await h.api("PATCH", `/api/bots/${bot.id}`, {
      modelSelection: { instanceId: "claude", model: "claude-sonnet" },
    });
    expect(patched.status).toBe(200);

    const send = await h.api("POST", `/api/bots/${bot.id}/messages`, { text: "hello?" });
    expect(send.status).toBe(202);

    const blocked = await h.sse.until(
      (f) => f.kind === "bot" && f.bot?.id === bot.id && f.bot?.state === "BLOCKED",
      8_000,
    );
    expect(blocked.bot?.stateCode).toBe("engine_unavailable");
    expect(String(blocked.bot?.stateDetail)).toContain("`claude` CLI not found");
    expect(String(blocked.bot?.stateDetail)).not.toMatch(/The selected engine CLI is not available/);
    expect(String(blocked.bot?.stateDetail)).not.toMatch(/spawn_error/i);

    const spawned = h.sse.frames.some(
      (f) => f.kind === "runtime" && (f.event?.type === "runtime.error" || f.event?.type === "turn.started"),
    );
    expect(spawned).toBe(false);

    const card = await h.sse.until(
      (f) =>
        f.kind === "message" &&
        f.threadId === bot.threadId &&
        f.message?.card?.requestType === "setup",
      8_000,
    );
    expect(card.message?.card?.options?.[0]).toBe(SWITCH_MODEL_OPTION);
  });
});
