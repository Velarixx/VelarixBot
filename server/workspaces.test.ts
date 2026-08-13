// Two cloud bots can run at once once each has its own Box workspace.
// Uses the fake Claude CLI in hang mode so a turn stays busy without a live
// box — claudeAgent because PATCH computer:"cloud" is 409'd for drivers
// without the cloudComputer capability (the ACP fakes ride grokAgent).
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { bestEffortRm, stopChild } from "./testing/harness.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLI = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const PORT = 18800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;
describe("per-bot box workspaces (no shared 409)", () => {
  let child: ChildProcess;
  let home: string;
  let stderr = "";

  const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };

  beforeAll(async () => {
    chmodSync(FAKE_CLI, 0o755);
    home = mkdtempSync(join(tmpdir(), "omb-box-ws-"));
    mkdirSync(join(home, ".openmausbot"), { recursive: true });
    writeFileSync(
      join(home, ".openmausbot", "config.json"),
      JSON.stringify({
        instances: {
          claude: {
            driver: "claudeAgent",
            environment: { FAKE_CLAUDE_MODE: "hang" },
            config: { cli: FAKE_CLI, permissionMode: "bypassPermissions" },
          },
        },
      }),
    );
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env: {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        HOME: home,
        USERPROFILE: home,
        OMB_PORT: String(PORT),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", (c) => (stderr += c));
    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        if ((await fetch(`${BASE}/api/health`)).ok) break;
      } catch {
        /* not up */
      }
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr}`);
      await new Promise((r) => setTimeout(r, 150));
    }
  }, 30_000);

  afterAll(async () => {
    await stopChild(child);
    bestEffortRm(home);
  });

  it("bot A busy on cloud does not 409 bot B", async () => {
    const seeded = (await api("GET", "/api/bots")).body.bots[0];
    await api("PATCH", `/api/bots/${seeded.id}`, { hidden: true });
    const selection = { instanceId: "claude", model: "claude-fake" };
    const a = (await api("POST", "/api/bots")).body.bot;
    const b = (await api("POST", "/api/bots")).body.bot;
    const pa = await api("PATCH", `/api/bots/${a.id}`, { name: "Alpha", computer: "cloud", modelSelection: selection });
    const pb = await api("PATCH", `/api/bots/${b.id}`, { name: "Bravo", computer: "cloud", modelSelection: selection });
    expect(pa.status).toBe(200);
    expect(pb.status).toBe(200);

    const first = await api("POST", `/api/bots/${a.id}/messages`, { text: "occupy the box" });
    expect(first.status).toBe(202);
    const second = await api("POST", `/api/bots/${b.id}/messages`, { text: "I have my own workspace" });
    expect(second.status).toBe(202);
    expect(second.body.error).toBeUndefined();

    await api("POST", `/api/bots/${a.id}/interrupt`);
    await api("POST", `/api/bots/${b.id}/interrupt`);
  });
});
