// API smoke test: boots the real harness server (node server/index.ts)
// against a throwaway home directory and exercises the HTTP surface the
// app depends on. The config pins one deliberately-unknown driver so the
// suite is deterministic with or without agent CLIs installed — and pins
// the shadow-instance behavior end to end while it's at it.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");
const PORT = 18800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;
const COMMS_TOKEN = "test-create-bot-token";

let child: ChildProcess;
let home: string;
let stderr = "";

const api = async (method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
};

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "omb-api-test-"));
  // a fleet of exactly one unknown driver: no CLI probes, no network
  mkdirSync(join(home, ".openmausbot"), { recursive: true });
  writeFileSync(
    join(home, ".openmausbot", "config.json"),
    JSON.stringify({ instances: { ghost: { driver: "not-a-real-driver", displayName: "Ghost" } } }),
  );

  child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
    cwd: ROOT,
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        HOME: home,
        USERPROFILE: home,
        OMB_PORT: String(PORT),
        OMB_COMMS_TOKEN: COMMS_TOKEN,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr!.on("data", (c) => (stderr += c));

  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}, 30_000);

afterAll(async () => {
  child?.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    child.on("close", () => resolve());
    setTimeout(() => (child.kill("SIGKILL"), resolve()), 5_000).unref?.();
  });
  rmSync(home, { recursive: true, force: true });
});

describe("harness HTTP API", () => {
  it("identifies itself on /api/health", async () => {
    const { status, body } = await api("GET", "/api/health");
    expect(status).toBe(200);
    expect(body.app).toBe("velarixbot");
    expect(typeof body.pid).toBe("number");
  });

  it("seeds one starter bot with its greeting", async () => {
    const { status, body } = await api("GET", "/api/bots");
    expect(status).toBe(200);
    expect(body.bots.length).toBeGreaterThanOrEqual(1);
    expect(body.bots[0].messages.length).toBeGreaterThanOrEqual(2);
  });

  it("describes the configured fleet, shadows included", async () => {
    const { status, body } = await api("GET", "/api/instances");
    expect(status).toBe(200);
    expect(body.instances).toHaveLength(1);
    expect(body.instances[0]).toMatchObject({
      instanceId: "ghost",
      driverKind: "not-a-real-driver",
      displayName: "Ghost",
      snapshot: { state: "unavailable" },
    });
    expect(body.instances[0].snapshot.reason).toContain("not-a-real-driver");
  });

  it("creates, patches, and deletes a bot", async () => {
    const created = await api("POST", "/api/bots");
    expect(created.status).toBe(201);
    const bot = created.body.bot;

    const patched = await api("PATCH", `/api/bots/${bot.id}`, { name: "Renamed", pinned: true });
    expect(patched.status).toBe(200);
    expect(patched.body.bot).toMatchObject({ name: "Renamed", pinned: true });

    const missing = await api("PATCH", "/api/bots/does-not-exist", { name: "x" });
    expect(missing.status).toBe(404);

    const deleted = await api("DELETE", `/api/bots/${bot.id}`);
    expect(deleted.status).toBe(200);
    const after = await api("GET", "/api/bots");
    expect(after.body.bots.find((b: { id: string }) => b.id === bot.id)).toBeUndefined();
  });

  it("persists an answered onboarding card", async () => {
    const { body } = await api("GET", "/api/bots");
    const bot = body.bots[0];
    const card = bot.messages.find((m: { kind: string }) => m.kind === "options");
    const res = await api("PATCH", `/api/bots/${bot.id}/cards/${card.id}`, { answered: card.card.options[0] });
    expect(res.status).toBe(200);
    expect(res.body.message.card.answered).toBe(card.card.options[0]);
  });

  it("rejects an empty message and explains an unavailable provider", async () => {
    const { body } = await api("GET", "/api/bots");
    const bot = body.bots[0];

    const empty = await api("POST", `/api/bots/${bot.id}/messages`, { text: "   " });
    expect(empty.status).toBe(400);

    // the seeded bot's selection points at the ghost instance — sending a
    // real message must fail loudly, not 202-and-hang
    const send = await api("POST", `/api/bots/${bot.id}/messages`, { text: "hello?" });
    expect(send.status).toBe(409);
    expect(send.body.error).toContain("unavailable");
  });

  it("saves config keys write-only and reports booleans", async () => {
    const before = await api("GET", "/api/config");
    expect(before.body.box).toEqual({ configured: false });

    const put = await api("PUT", "/api/config", { box: { token: "tok_secret_value" } });
    expect(put.status).toBe(200);
    expect(put.body.box).toEqual({ configured: true });
    expect(JSON.stringify(put.body)).not.toContain("tok_secret_value");

    const after = await api("GET", "/api/config");
    expect(after.body.box).toEqual({ configured: true });
    expect(JSON.stringify(after.body)).not.toContain("tok_secret_value");

    const github = await api("PUT", "/api/config", { github: { token: "ghp_test_secret_token" } });
    expect(github.status).toBe(200);
    expect(github.body.github).toEqual({ configured: true });
    expect(JSON.stringify(github.body)).not.toContain("ghp_test_secret_token");
    const githubGet = await api("GET", "/api/config");
    expect(githubGet.body.github).toEqual({ configured: true });
    expect(JSON.stringify(githubGet.body)).not.toContain("ghp_test_secret_token");

    const nothing = await api("PUT", "/api/config", {});
    expect(nothing.status).toBe(400);
  });

  it("does not accept or echo identity/profile data", async () => {
    const put = await api("PUT", "/api/config", { profile: { name: "Ada Lovelace", email: "Ada@Example.com" } });
    expect(put.status).toBe(400);
    const after = await api("GET", "/api/config");
    expect(after.body.profile).toBeUndefined();
    expect(JSON.stringify(after.body)).not.toContain("Ada@Example.com");
  });

  it("create-bot is token-gated and adds a named bot to the roster", async () => {
    const denied = await api("POST", "/api/internal/create-bot", {
      name: "Ops",
      title: "Ops specialist",
      description: "Handles ops",
    });
    expect(denied.status).toBe(401);

    const missing = await api(
      "POST",
      "/api/internal/create-bot",
      { name: "Ops", title: "", description: "" },
      { authorization: `Bearer ${COMMS_TOKEN}` },
    );
    expect(missing.status).toBe(400);

    const hop = await api(
      "POST",
      "/api/internal/create-bot",
      { name: "Ops", title: "Ops specialist", description: "Handles ops", depth: 2 },
      { authorization: `Bearer ${COMMS_TOKEN}` },
    );
    expect(hop.status).toBe(200);
    expect(hop.body.error).toContain("two hops");

    const created = await api(
      "POST",
      "/api/internal/create-bot",
      {
        name: "Ops",
        title: "Ops specialist",
        description: "Handles ops",
        model: "ghost-model",
      },
      { authorization: `Bearer ${COMMS_TOKEN}` },
    );
    expect(created.status).toBe(200);
    expect(created.body.bot).toMatchObject({
      name: "Ops",
      title: "Ops specialist",
      description: "Handles ops",
      model: "ghost-model",
    });
    expect(created.body.bot.id).toBeTruthy();
    expect(JSON.stringify(created.body)).not.toContain(COMMS_TOKEN);

    const roster = await api("GET", "/api/bots");
    const ops = roster.body.bots.find((b: { name: string }) => b.name === "Ops");
    expect(ops).toBeTruthy();
    expect(ops.title).toBe("Ops specialist");
    expect(ops.modelSelection.model).toBe("ghost-model");
  });

  it("round-trips a daily routine create payload", async () => {
    const { body } = await api("GET", "/api/bots");
    const bot = body.bots[0];
    const created = await api("POST", "/api/routines", {
      botId: bot.id,
      name: "Morning briefing",
      prompt: "Summarize the day",
      schedule: { kind: "daily", time: "07:15" },
    });
    expect(created.status).toBe(201);
    expect(created.body.routine.schedule).toEqual({ kind: "daily", time: "07:15" });
    const listed = await api("GET", "/api/routines");
    const found = listed.body.routines.find((r: { id: string }) => r.id === created.body.routine.id);
    expect(found.schedule).toEqual({ kind: "daily", time: "07:15" });
  });

  it("round-trips a routine thenStartTurn trigger", async () => {
    const { body } = await api("GET", "/api/bots");
    const bot = body.bots[0];
    const created = await api("POST", "/api/routines", {
      botId: bot.id,
      name: "Then trigger",
      prompt: "Do the thing",
      schedule: { kind: "interval", everyMinutes: 15 },
      thenStartTurn: { botId: bot.id, prompt: "Follow up." },
    });
    expect(created.status).toBe(201);
    expect(created.body.routine.thenStartTurn).toEqual({ botId: bot.id, prompt: "Follow up." });
  });

  it("saves a taught skill and attaches it to a routine payload", async () => {
    const { body } = await api("GET", "/api/bots");
    const bot = body.bots[0];
    const skill = await api("POST", "/api/skills", {
      botId: bot.id,
      name: "File a report",
      markdown: "# File a report\n\n1. Open Chrome\n2. Submit\n",
    });
    expect(skill.status).toBe(201);
    expect(skill.body.skill.markdown).toMatch(/1\. Open Chrome/);
    const created = await api("POST", "/api/routines", {
      botId: bot.id,
      name: "Taught routine",
      prompt: "Run the skill",
      schedule: { kind: "interval", everyMinutes: 30 },
      skillId: skill.body.skill.id,
    });
    expect(created.status).toBe(201);
    expect(created.body.routine.skillId).toBe(skill.body.skill.id);
    const listed = await api("GET", "/api/skills");
    expect(listed.body.skills.some((s: { id: string }) => s.id === skill.body.skill.id)).toBe(true);
  });

  it("records a teach session into a reviewable skill without a live box", async () => {
    const { body } = await api("GET", "/api/bots");
    const bot = body.bots[0];
    const start = await api("POST", `/api/bots/${bot.id}/teach/start`);
    expect(start.status).toBe(200);
    expect(start.body.recording).toBe(true);
    const stop = await api("POST", `/api/bots/${bot.id}/teach/stop`, { name: "Empty session" });
    expect(stop.status).toBe(200);
    expect(stop.body.skill.markdown).toMatch(/1\./);
    expect(stop.body.skill.name).toBe("Empty session");
  });

  it("stores per-bot enabledApps toggles", async () => {
    const created = await api("POST", "/api/bots");
    const bot = created.body.bot;
    const patched = await api("PATCH", `/api/bots/${bot.id}`, { enabledApps: ["googledrive"] });
    expect(patched.status).toBe(200);
    expect(patched.body.bot.enabledApps).toEqual(["googledrive"]);
    const other = await api("POST", "/api/bots");
    expect(other.body.bot.enabledApps ?? []).toEqual([]);
  });

  it("404s unknown routes with the route in the error", async () => {
    const res = await api("GET", "/api/definitely-not-a-route");
    expect(res.status).toBe(404);
    expect(res.body.error).toContain("/api/definitely-not-a-route");
  });
});
