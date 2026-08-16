// API smoke test: boots the real harness server (node server/index.ts)
// against a throwaway home directory and exercises the HTTP surface the
// app depends on. The config pins one deliberately-unknown driver so the
// suite is deterministic with or without agent CLIs installed — and pins
// the shadow-instance behavior end to end while it's at it.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { seedAvatar } from "./avatar-seed.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");
const PORT = 18800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;
const COMMS_TOKEN = "test-create-bot-token";
const API_TOKEN = "test-public-api-token";

let child: ChildProcess;
let home: string;
let stderr = "";

const api = async (method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      authorization: `Bearer ${API_TOKEN}`,
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
};

/** Open /api/events and fold JSON frames. Wait on stream events — no sleeps. */
async function openSse(): Promise<{
  frames: any[];
  until: (pred: (frames: any[]) => boolean) => Promise<void>;
  close: () => void;
}> {
  const res = await fetch(`${BASE}/api/events`, { headers: { authorization: `Bearer ${API_TOKEN}` } });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const frames: any[] = [];
  const waiters: Array<() => void> = [];
  let reading = true;
  const close = () => {
    reading = false;
    reader.cancel().catch(() => {});
  };
  const notify = () => {
    for (const w of waiters.splice(0)) w();
  };
  const pump = (async () => {
    while (reading) {
      const { done, value } = await reader.read();
      if (done) {
        reading = false;
        break;
      }
      buf += decoder.decode(value, { stream: true });
      const chunks = buf.split("\n\n");
      buf = chunks.pop() ?? "";
      for (const chunk of chunks) {
        const line = chunk.split("\n").find((l) => l.startsWith("data: "));
        if (!line) continue;
        try {
          frames.push(JSON.parse(line.slice(6)));
        } catch {
          /* keepalive / non-JSON */
        }
      }
      notify();
    }
    notify();
  })();
  void pump;
  const until = async (pred: (frames: any[]) => boolean) => {
    await new Promise<void>((resolve, reject) => {
      const tick = () => {
        if (pred(frames)) {
          resolve();
          return;
        }
        if (!reading) {
          reject(new Error(`SSE closed before matching frame. saw ${JSON.stringify(frames.map((f) => f.kind))}`));
          return;
        }
        if (!waiters.includes(tick)) waiters.push(tick);
      };
      waiters.push(tick);
      tick();
    });
  };
  await until((list) => list.some((f) => f.kind === "hello"));
  return { frames, until, close };
}

// a clearly-fake plaintext secret seeded into the pre-boot config.json to pin
// the P1.5 boot migration (constructed at runtime, never credential-shaped)
const SEEDED_XAI_KEY = ["fake", "seeded", "xai", "canary", Date.now().toString(36)].join("-");

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "omb-api-test-"));
  // a fleet of exactly one unknown driver: no CLI probes, no network —
  // plus one plaintext secret the boot migration must move out of the file
  mkdirSync(join(home, ".openmausbot"), { recursive: true });
  writeFileSync(
    join(home, ".openmausbot", "config.json"),
    JSON.stringify({
      xai: { key: SEEDED_XAI_KEY },
      instances: { ghost: { driver: "not-a-real-driver", displayName: "Ghost" } },
    }),
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
        VELARIX_DEV_TOKEN: API_TOKEN,
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
    expect(body.stamp).toBe("ensureBotWorkspace+mcpOverlay");
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
    const ghost = body.instances.find((i: { instanceId: string }) => i.instanceId === "ghost");
    expect(ghost).toMatchObject({
      instanceId: "ghost",
      driverKind: "not-a-real-driver",
      displayName: "Ghost",
      snapshot: { state: "unavailable" },
    });
    expect(ghost.snapshot.reason).toContain("not-a-real-driver");
    const openrouter = body.instances.find((i: { instanceId: string }) => i.instanceId === "openrouter");
    expect(openrouter?.driverKind).toBe("openrouter");
    expect(openrouter?.snapshot.state).toBe("unavailable");
    expect(openrouter?.snapshot.reason).toMatch(/OpenRouter API key/);
    const omnirouter = body.instances.find((i: { instanceId: string }) => i.instanceId === "omnirouter");
    expect(omnirouter?.snapshot.state).toBe("unavailable");
    expect(omnirouter?.snapshot.reason).toMatch(/OmniRouter API key/);
    expect(JSON.stringify(body)).not.toContain("sk-or-v1-");
  });

  it("exports diagnostics behind the token — versions, capabilities, integrity, and NO transcripts", async () => {
    // the export is token-gated like every /api route (only /api/health is open)
    const denied = await fetch(`${BASE}/api/diagnostics/export`);
    expect(denied.status).toBe(401);

    const roster = await api("GET", "/api/bots");
    const transcriptLine = roster.body.bots[0].messages.find((m: { kind: string }) => m.kind === "text")?.text;
    expect(typeof transcriptLine).toBe("string");

    const { status, body } = await api("GET", "/api/diagnostics/export");
    expect(status).toBe(200);
    expect(body.format).toBe("velarixbot-diagnostics");
    expect(body.transcriptsIncluded).toBe(false);
    expect(body.versions.node).toBe(process.version); // spawned with the same node
    expect(body.versions.schemaVersion).toBeGreaterThanOrEqual(3);
    expect(body.integrity.result).toBe("ok");
    const ghost = body.capabilities.providers.find((p: { instanceId: string }) => p.instanceId === "ghost");
    expect(ghost).toMatchObject({ driverKind: "not-a-real-driver", state: "unavailable" });
    expect(body.capabilities.computers.some((c: { kind: string }) => c.kind === "local")).toBe(true);
    // the transcript that exists in this profile is NOT in the bundle
    expect(JSON.stringify(body)).not.toContain(transcriptLine);
  });

  it("backs up the profile on demand and reports the verified manifest", async () => {
    const { status, body } = await api("POST", "/api/diagnostics/backup");
    expect(status).toBe(200);
    expect(typeof body.path).toBe("string");
    expect(body.manifest.integrity).toBe("ok");
    expect(body.manifest.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(body.manifest.tables.bots).toBeGreaterThanOrEqual(1);
  });

  it("creates, patches, and deletes a bot", async () => {
    const created = await api("POST", "/api/bots");
    expect(created.status).toBe(201);
    const bot = created.body.bot;
    expect(bot.computer).toBe("off");

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

  it("seeds the avatar at create and regenerates the same face from the persisted nonce", async () => {
    const created = await api("POST", "/api/bots");
    expect(created.status).toBe(201);
    const bot = created.body.bot;
    // create derives from the seed, and the seed is on the record
    expect(bot.avatarNonce).toBe(0);
    const birth = seedAvatar({ botId: bot.id, nonce: 0 });
    expect(bot.color).toBe(birth.color);
    expect(bot.iconShape).toBe(birth.iconShape);

    // re-roll over the SAME gated PATCH route every other bot field uses
    const denied = await fetch(`${BASE}/api/bots/${bot.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ avatarNonce: 5 }),
    });
    expect(denied.status).toBe(401);

    const face = seedAvatar({ botId: bot.id, nonce: 5 });
    const patched = await api("PATCH", `/api/bots/${bot.id}`, { avatarNonce: 5 });
    expect(patched.status).toBe(200);
    expect(patched.body.bot).toMatchObject({
      avatarNonce: 5,
      color: face.color,
      iconShape: face.iconShape,
      mascotExpression: face.mascotExpression,
    });

    // GET returns the persisted seed AND the derived face — reload-safe
    const listed = await api("GET", "/api/bots");
    expect(listed.body.bots.find((b: { id: string }) => b.id === bot.id)).toMatchObject({
      avatarNonce: 5,
      color: face.color,
      iconShape: face.iconShape,
      mascotExpression: face.mascotExpression,
    });

    const bad = await api("PATCH", `/api/bots/${bot.id}`, { avatarNonce: -3 });
    expect(bad.status).toBe(400);

    const deleted = await api("DELETE", `/api/bots/${bot.id}`);
    expect(deleted.status).toBe(200);
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

    const or = await api("PUT", "/api/config", { openrouter: { key: "sk-or-v1-secret-openrouter" } });
    expect(or.status).toBe(200);
    expect(or.body.openrouter).toEqual({ configured: true });
    expect(JSON.stringify(or.body)).not.toContain("sk-or-v1-secret-openrouter");
    const afterOr = await api("GET", "/api/instances");
    const liveOr = afterOr.body.instances.find((i: { instanceId: string }) => i.instanceId === "openrouter");
    expect(liveOr?.snapshot.state).toBe("available");
    expect(JSON.stringify(afterOr.body)).not.toContain("sk-or-v1-secret-openrouter");
    const omni = await api("PUT", "/api/config", { omnirouter: { key: "omni_secret_token" } });
    expect(omni.status).toBe(200);
    expect(omni.body.omnirouter).toEqual({ configured: true });
    expect(JSON.stringify(omni.body)).not.toContain("omni_secret_token");

    const nothing = await api("PUT", "/api/config", {});
    expect(nothing.status).toBe(400);
  });

  it("boot migrated the seeded plaintext secret out of config.json", async () => {
    // seeded pre-boot as plaintext (see beforeAll) — post-migration the file
    // holds a secret:// ref and the value lives only in the secret store
    const configRaw = readFileSync(join(home, ".velarixbot", "config.json"), "utf8");
    expect(configRaw).not.toContain(SEEDED_XAI_KEY);
    expect(JSON.parse(configRaw).xai.key).toBe("secret://xai.key");
    const secretsRaw = readFileSync(join(home, ".velarixbot", "secrets.json"), "utf8");
    expect(secretsRaw).not.toContain(SEEDED_XAI_KEY);
    expect(JSON.parse(secretsRaw).entries["xai.key"]).toBeTruthy();
    // and it still counts as configured
    const { body } = await api("GET", "/api/config");
    expect(body.xai).toEqual({ configured: true });
  });

  it("PUT /api/config writes secret refs to disk; clearing deletes ref and secret", async () => {
    const configPath = join(home, ".velarixbot", "config.json");
    const secretsPath = join(home, ".velarixbot", "secrets.json");
    const newKey = ["fake", "replaced", "xai", "canary", Date.now().toString(36)].join("-");

    const put = await api("PUT", "/api/config", { xai: { key: newKey } });
    expect(put.status).toBe(200);
    expect(put.body.xai).toEqual({ configured: true });
    const rawAfterPut = readFileSync(configPath, "utf8");
    expect(rawAfterPut).not.toContain(newKey);
    expect(JSON.parse(rawAfterPut).xai.key).toBe("secret://xai.key");
    expect(readFileSync(secretsPath, "utf8")).not.toContain(newKey);

    // clearing from the UI sends an empty string: the ref leaves config.json
    // AND the stored secret is deleted
    const cleared = await api("PUT", "/api/config", { xai: { key: "" } });
    expect(cleared.status).toBe(200);
    expect(cleared.body.xai).toEqual({ configured: false });
    const rawAfterClear = readFileSync(configPath, "utf8");
    expect(rawAfterClear).not.toContain("secret://xai.key");
    expect(rawAfterClear).not.toContain(newKey);
    expect(JSON.parse(readFileSync(secretsPath, "utf8")).entries["xai.key"]).toBeUndefined();
    const status = await api("GET", "/api/config");
    expect(status.body.xai).toEqual({ configured: false });
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
      // the legacy "cloud" request resolves to the bundled box BINDING
      computer: "box",
    });
    expect(created.body.bot.id).toBeTruthy();
    expect(JSON.stringify(created.body)).not.toContain(COMMS_TOKEN);

    const roster = await api("GET", "/api/bots");
    const ops = roster.body.bots.find((b: { name: string }) => b.name === "Ops");
    expect(ops).toBeTruthy();
    expect(ops.title).toBe("Ops specialist");
    expect(ops.modelSelection.model).toBe("ghost-model");
  });

  it("round-trips a daily routine create payload and stamps an explicit time zone", async () => {
    const { body } = await api("GET", "/api/bots");
    const bot = body.bots[0];
    const created = await api("POST", "/api/routines", {
      botId: bot.id,
      name: "Morning briefing",
      prompt: "Summarize the day",
      schedule: { kind: "daily", time: "07:15" },
    });
    expect(created.status).toBe(201);
    expect(created.body.routine.schedule).toMatchObject({ kind: "daily", time: "07:15" });
    // clock schedules always carry the zone they were created in
    expect(typeof created.body.routine.schedule.timeZone).toBe("string");
    expect(created.body.routine.schedule.timeZone.length).toBeGreaterThan(0);
    expect(created.body.routine.missedPolicy).toBe("run-once");
    const listed = await api("GET", "/api/routines");
    const found = listed.body.routines.find((r: { id: string }) => r.id === created.body.routine.id);
    expect(found.schedule).toEqual(created.body.routine.schedule);
  });

  it("round-trips the missed policy and rejects bad values", async () => {
    const { body } = await api("GET", "/api/bots");
    const bot = body.bots[0];
    const created = await api("POST", "/api/routines", {
      botId: bot.id,
      name: "Catch-up routine",
      prompt: "Catch up",
      schedule: { kind: "interval", everyMinutes: 30 },
      missedPolicy: "catch-up",
    });
    expect(created.status).toBe(201);
    expect(created.body.routine.missedPolicy).toBe("catch-up");
    const patched = await api("PATCH", `/api/routines/${created.body.routine.id}`, { missedPolicy: "skip" });
    expect(patched.status).toBe(200);
    expect(patched.body.routine.missedPolicy).toBe("skip");
    const rejected = await api("PATCH", `/api/routines/${created.body.routine.id}`, { missedPolicy: "whenever" });
    expect(rejected.status).toBe(500);
    expect(rejected.body.error).toMatch(/invalid missed policy/);
  });

  it("serves per-routine run history and records a manual test run", async () => {
    const { body } = await api("GET", "/api/bots");
    const bot = body.bots[0];
    const created = await api("POST", "/api/routines", {
      botId: bot.id,
      name: "History probe",
      prompt: "Probe",
      schedule: { kind: "interval", everyMinutes: 60 },
    });
    expect(created.status).toBe(201);
    const id = created.body.routine.id as string;
    const nextBefore = created.body.routine.nextRunAt as number;

    const empty = await api("GET", `/api/routines/${id}/runs`);
    expect(empty.status).toBe(200);
    expect(empty.body.runs).toEqual([]);

    // the manual run row is claimed synchronously inside the POST
    const run = await api("POST", `/api/routines/${id}/run`);
    expect(run.status).toBe(202);
    const runs = await api("GET", `/api/routines/${id}/runs`);
    expect(runs.body.runs).toHaveLength(1);
    expect(runs.body.runs[0]).toMatchObject({ kind: "manual", attempt: 1 });
    expect(["running", "blocked"]).toContain(runs.body.runs[0].status);

    // a test run never consumes the scheduled occurrence
    const after = await api("GET", "/api/routines");
    expect(after.body.routines.find((r: { id: string }) => r.id === id).nextRunAt).toBe(nextBefore);

    expect((await api("GET", "/api/routines/nope/runs")).status).toBe(404);
    expect((await api("POST", "/api/routines/nope/run")).status).toBe(404);
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
    expect(start.body.session.status).toBe("recording");
    const listed = await api("GET", "/api/teach-sessions");
    expect(listed.status).toBe(200);
    expect(listed.body.sessions.some((s: { botId: string; status: string }) => s.botId === bot.id && s.status === "recording")).toBe(true);
    const current = await api("GET", `/api/bots/${bot.id}/teach`);
    expect(current.body.session.status).toBe("recording");
    const stop = await api("POST", `/api/bots/${bot.id}/teach/stop`, { name: "Empty session" });
    expect(stop.status).toBe(200);
    expect(stop.body.skill.markdown).toMatch(/1\./);
    expect(stop.body.skill.name).toBe("Empty session");
    expect(stop.body.session.status).toBe("completed");
    expect(stop.body.session.skillId).toBe(stop.body.skill.id);
    const after = await api("GET", "/api/teach-sessions");
    expect(after.body.sessions.some((s: { id: string; status: string }) => s.id === stop.body.session.id && s.status === "completed")).toBe(true);
  });

  it("attaches a skill to a bot and persists iconShape", async () => {
    const created = await api("POST", "/api/bots");
    const bot = created.body.bot;
    const skill = await api("POST", "/api/skills", {
      botId: bot.id,
      name: "Desk skill",
      markdown: "# Desk skill\n\n1. Open the inbox\n",
    });
    expect(skill.status).toBe(201);
    const patched = await api("PATCH", `/api/bots/${bot.id}`, { skillId: skill.body.skill.id, iconShape: "hexagon" });
    expect(patched.status).toBe(200);
    expect(patched.body.bot.skillId).toBe(skill.body.skill.id);
    expect(patched.body.bot.iconShape).toBe("hexagon");
    const listed = await api("GET", "/api/bots");
    const found = listed.body.bots.find((b: { id: string }) => b.id === bot.id);
    expect(found.skillId).toBe(skill.body.skill.id);
    expect(found.iconShape).toBe("hexagon");
  });

  it("round-trips bot memory and writes workspace.md", async () => {
    const created = await api("POST", "/api/bots");
    const bot = created.body.bot;
    const empty = await api("GET", `/api/bots/${bot.id}/memory`);
    expect(empty.status).toBe(200);
    expect(empty.body).toMatchObject({ user: "", distilled: "", workspace: "" });

    const put = await api("PUT", `/api/bots/${bot.id}/memory`, {
      user: "Call me Sam.",
      distilled: "Prefers bullets.",
      workspace: "Team ships on Fridays.",
    });
    expect(put.status).toBe(200);
    expect(put.body.user).toContain("Call me Sam.");
    expect(put.body.distilled).toContain("Prefers bullets.");
    expect(put.body.workspace).toContain("Team ships on Fridays.");
    expect(existsSync(join(home, ".velarixbot", "memory", "workspace.md"))).toBe(true);
    expect(existsSync(join(home, ".velarixbot", "memory", `${bot.id}.md`))).toBe(true);

    const denied = await api("POST", "/api/internal/remember", { fromBotId: bot.id, note: "secret-note" });
    expect(denied.status).toBe(401);

    const remember = await api(
      "POST",
      "/api/internal/remember",
      { fromBotId: bot.id, note: "Timezone is CET.", scope: "bot" },
      { authorization: `Bearer ${COMMS_TOKEN}` },
    );
    expect(remember.status).toBe(200);
    expect(JSON.stringify(remember.body)).not.toContain(COMMS_TOKEN);

    const workspaceNote = await api(
      "POST",
      "/api/internal/remember",
      { fromBotId: bot.id, note: "No deploys on Monday.", scope: "workspace" },
      { authorization: `Bearer ${COMMS_TOKEN}` },
    );
    expect(workspaceNote.status).toBe(200);

    const recall = await api(
      "POST",
      "/api/internal/recall",
      { fromBotId: bot.id, query: "Monday" },
      { authorization: `Bearer ${COMMS_TOKEN}` },
    );
    expect(recall.status).toBe(200);
    expect(recall.body.text).toContain("No deploys on Monday.");
    expect(recall.body.text).not.toContain("Call me Sam.");
    expect(JSON.stringify(recall.body)).not.toContain(COMMS_TOKEN);

    const all = await api("GET", `/api/bots/${bot.id}/memory`);
    expect(all.body.user).toContain("Timezone is CET.");
    expect(all.body.workspace).toContain("No deploys on Monday.");

    const nothing = await api("PUT", `/api/bots/${bot.id}/memory`, {});
    expect(nothing.status).toBe(400);
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

  it("lists and revokes per-bot approval rules without echoing secrets", async () => {
    const created = await api("POST", "/api/bots");
    const bot = created.body.bot;
    const dir = join(home, ".velarixbot", "approvals");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${bot.id}.json`),
      JSON.stringify([
        { id: "rule-keep", tool: "Bash", pattern: "git status", action: "allow", createdAt: 1 },
        { id: "rule-drop", tool: "Bash", pattern: "rm -rf *", action: "deny", createdAt: 2 },
      ]),
    );
    const listed = await api("GET", `/api/bots/${bot.id}/approvals`);
    expect(listed.status).toBe(200);
    expect(listed.body.rules.map((r: { id: string }) => r.id).sort()).toEqual(["rule-drop", "rule-keep"]);
    expect(JSON.stringify(listed.body)).not.toMatch(/sk-|xai-|ghp_/i);
    const revoked = await api("DELETE", `/api/bots/${bot.id}/approvals/rule-drop`);
    expect(revoked.status).toBe(200);
    const after = await api("GET", `/api/bots/${bot.id}/approvals`);
    expect(after.body.rules.map((r: { id: string }) => r.id)).toEqual(["rule-keep"]);
    const missing = await api("DELETE", `/api/bots/${bot.id}/approvals/rule-drop`);
    expect(missing.status).toBe(404);
  });

  it("reconfirms a quarantined rule via PATCH and rejects other patches", async () => {
    const created = await api("POST", "/api/bots");
    const bot = created.body.bot;
    const dir = join(home, ".velarixbot", "approvals");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${bot.id}.json`),
      JSON.stringify([
        { id: "rule-paused", tool: "shell", pattern: "*", action: "allow", createdAt: 1, disabled: true, quarantined: true },
      ]),
    );
    const listed = await api("GET", `/api/bots/${bot.id}/approvals`);
    expect(listed.body.rules[0]).toMatchObject({ id: "rule-paused", disabled: true, quarantined: true });

    const badPatch = await api("PATCH", `/api/bots/${bot.id}/approvals/rule-paused`, { pattern: "*" });
    expect(badPatch.status).toBe(400);

    const confirmed = await api("PATCH", `/api/bots/${bot.id}/approvals/rule-paused`, { confirmed: true });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.rule).toMatchObject({ id: "rule-paused", confirmed: true });
    expect(confirmed.body.rule.disabled).toBeUndefined();
    expect(confirmed.body.rule.quarantined).toBeUndefined();

    const missing = await api("PATCH", `/api/bots/${bot.id}/approvals/nope`, { confirmed: true });
    expect(missing.status).toBe(404);
  });

  it("broadcasts routine SSE frames when markRoutine and delete run", async () => {
    const { body } = await api("GET", "/api/bots");
    const bot = body.bots[0];
    const created = await api("POST", "/api/routines", {
      botId: bot.id,
      name: "SSE ping",
      prompt: "Ping",
      schedule: { kind: "interval", everyMinutes: 60 },
    });
    expect(created.status).toBe(201);
    const id = created.body.routine.id as string;
    const sse = await openSse();
    try {
      const run = await api("POST", `/api/routines/${id}/run`);
      expect(run.status).toBe(202);
      await sse.until((frames) => frames.some((f) => f.kind === "routine" && f.routine?.id === id));
      const deleted = await api("DELETE", `/api/routines/${id}`);
      expect(deleted.status).toBe(200);
      await sse.until((frames) => frames.some((f) => f.kind === "routine.deleted" && f.routineId === id));
    } finally {
      sse.close();
    }
  });

  it("404s unknown routes with the route in the error", async () => {
    const res = await api("GET", "/api/definitely-not-a-route");
    expect(res.status).toBe(404);
    expect(res.body.error).toContain("/api/definitely-not-a-route");
  });

  it("update-bot is token-gated and patches name/title/description", async () => {
    const { body } = await api("GET", "/api/bots");
    const bot = body.bots[0];
    const denied = await api("POST", "/api/internal/update-bot", { bot_id: bot.id, name: "Nope" });
    expect(denied.status).toBe(401);

    const hop = await api(
      "POST",
      "/api/internal/update-bot",
      { bot_id: bot.id, name: "Nope", depth: 2 },
      { authorization: `Bearer ${COMMS_TOKEN}` },
    );
    expect(hop.status).toBe(200);
    expect(hop.body.error).toContain("two hops");

    const updated = await api(
      "POST",
      "/api/internal/update-bot",
      { bot_id: bot.id, name: "Chief", title: "Chief of Staff", description: "Runs the office" },
      { authorization: `Bearer ${COMMS_TOKEN}` },
    );
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({
      id: bot.id,
      name: "Chief",
      title: "Chief of Staff",
      description: "Runs the office",
    });
    expect(JSON.stringify(updated.body)).not.toContain(COMMS_TOKEN);
    const roster = await api("GET", "/api/bots");
    expect(roster.body.bots.find((b: { id: string }) => b.id === bot.id)).toMatchObject({
      name: "Chief",
      title: "Chief of Staff",
    });
  });

  it("workspace tools: fetch_page refuses private URLs, connect_app needs a key, routines default to weekdays", async () => {
    const { body } = await api("GET", "/api/bots");
    const bot = body.bots[0];
    const auth = { authorization: `Bearer ${COMMS_TOKEN}` };
    const denied = await api("POST", "/api/internal/workspace", { fromBotId: bot.id, tool: "web_search", args: { query: "x" } });
    expect(denied.status).toBe(401);

    const privatePage = await api(
      "POST",
      "/api/internal/workspace",
      { fromBotId: bot.id, tool: "fetch_page", args: { url: "http://127.0.0.1/secret" } },
      auth,
    );
    expect(privatePage.status).toBe(200);
    expect(privatePage.body.error).toMatch(/public http/i);

    const connect = await api(
      "POST",
      "/api/internal/workspace",
      { fromBotId: bot.id, tool: "connect_app", args: { slug: "github" } },
      auth,
    );
    expect(connect.status).toBe(200);
    expect(connect.body.error).toMatch(/Composio|App Settings/i);
    expect(connect.body.error).toMatch(/paste a token/i);

    const listener = await api(
      "POST",
      "/api/internal/workspace",
      { fromBotId: bot.id, tool: "create_routine", args: { name: "PRs", prompt: "Check PRs", listener: "github" } },
      auth,
    );
    expect(listener.body.error).toMatch(/connect_app/);
    expect(listener.body.error).not.toMatch(/ghp_|xoxb-|sk-/);

    const routine = await api(
      "POST",
      "/api/internal/workspace",
      { fromBotId: bot.id, tool: "create_routine", args: { name: "Standup", prompt: "Brief me", time: "09:00" } },
      auth,
    );
    expect(routine.status).toBe(200);
    expect(routine.body.text).toMatch(/weekdays/i);
    const listed = await api("GET", "/api/routines");
    const standup = listed.body.routines.find((r: { name: string }) => r.name === "Standup");
    expect(standup.schedule).toMatchObject({ kind: "weekdays", time: "09:00" });
    expect(typeof standup.schedule.timeZone).toBe("string");

    const saved = await api(
      "POST",
      "/api/internal/workspace",
      { fromBotId: bot.id, tool: "save_skill", args: { name: "File a bug", steps: "1. Reproduce\n2. File" } },
      auth,
    );
    expect(saved.body.text).toMatch(/Saved skill/);
    const skillId = /id: ([a-z0-9-]+)/i.exec(saved.body.text)?.[1];
    expect(skillId).toBeTruthy();
    const ran = await api(
      "POST",
      "/api/internal/workspace",
      { fromBotId: bot.id, tool: "run_skill", args: { skill_id: skillId } },
      auth,
    );
    expect(ran.body.text).toContain("1. Reproduce");

    const shot = await api(
      "POST",
      "/api/internal/workspace",
      { fromBotId: bot.id, tool: "attach_to_chat", args: { kind: "screenshot" } },
      auth,
    );
    expect(shot.body.error).toMatch(/computer/i);
  });

  it("ask_choice waits on a card; ask_secret never lands in the transcript, SSE, or stderr", async () => {
    const { body } = await api("GET", "/api/bots");
    const bot = body.bots[0];
    const auth = { authorization: `Bearer ${COMMS_TOKEN}` };
    const secret = "wifi-password-xyz-never-log";

    const sse = await openSse();
    try {
      const choicePending = api(
        "POST",
        "/api/internal/workspace",
        { fromBotId: bot.id, tool: "ask_choice", args: { question: "Ship it?", choices: ["Yes", "No"] } },
        auth,
      );
      await sse.until((frames) =>
        frames.some((f) => f.kind === "message" && f.message?.card?.requestType === "question" && f.message?.card?.options?.includes("Yes")),
      );
      const choiceFrame = sse.frames.find(
        (f) => f.kind === "message" && f.message?.card?.requestType === "question" && f.message?.card?.options?.includes("Yes"),
      );
      const choiceRespond = await api("POST", `/api/bots/${bot.id}/respond`, {
        requestId: choiceFrame.message.card.requestId,
        behavior: "answer",
        message: "Yes",
      });
      expect(choiceRespond.status).toBe(200);
      const choice = await choicePending;
      expect(choice.body.text).toBe("Yes");

      const secretPending = api(
        "POST",
        "/api/internal/workspace",
        { fromBotId: bot.id, tool: "ask_secret", args: { prompt: "Need the wifi password" } },
        auth,
      );
      await sse.until((frames) => frames.some((f) => f.kind === "message" && f.message?.card?.requestType === "secret"));
      const secretFrame = sse.frames.find((f) => f.kind === "message" && f.message?.card?.requestType === "secret");
      expect(JSON.stringify(sse.frames)).not.toContain(secret);
      const secretRespond = await api("POST", `/api/bots/${bot.id}/respond`, {
        requestId: secretFrame.message.card.requestId,
        behavior: "answer",
        message: secret,
      });
      expect(secretRespond.status).toBe(200);
      expect(JSON.stringify(secretRespond.body)).not.toContain(secret);
      const secretResult = await secretPending;
      expect(secretResult.body.text).toBe(secret);

      const roster = await api("GET", "/api/bots");
      const messages = roster.body.bots.find((b: { id: string }) => b.id === bot.id).messages;
      expect(JSON.stringify(messages)).not.toContain(secret);
      expect(JSON.stringify(messages)).toContain("••••");
      expect(JSON.stringify(sse.frames)).not.toContain(secret);
      expect(stderr).not.toContain(secret);
    } finally {
      sse.close();
    }
  });

  it("refuses to delete the last bot over HTTP (409) and MCP (error payload)", async () => {
    const roster = await api("GET", "/api/bots");
    for (const extra of roster.body.bots.slice(1)) {
      const del = await api("DELETE", `/api/bots/${extra.id}`);
      expect(del.status).toBe(200);
    }
    const last = (await api("GET", "/api/bots")).body.bots[0];
    expect(last).toBeTruthy();
    const http = await api("DELETE", `/api/bots/${last.id}`);
    expect(http.status).toBe(409);
    expect(http.body.error).toMatch(/last bot/i);
    const internal = await api(
      "POST",
      "/api/internal/delete-bot",
      { bot_id: last.id },
      { authorization: `Bearer ${COMMS_TOKEN}` },
    );
    expect(internal.status).toBe(200);
    expect(internal.body.error).toMatch(/last bot/i);
    const after = await api("GET", "/api/bots");
    expect(after.body.bots).toHaveLength(1);
    expect(after.body.bots[0].id).toBe(last.id);
  });
});
