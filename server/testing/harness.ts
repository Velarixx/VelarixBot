// Shared helpers for tests that boot the real harness HTTP/SSE server
// against a throwaway home and the scripted fake CLIs. No live agents.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { killProcessTree } from "../drivers/cli.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
export const TESTING_DIR = SERVER_DIR;
export const FAKE_ACP_CLI = join(TESTING_DIR, "fake-acp-cli.ts");
export const FAKE_CLAUDE_CLI = join(TESTING_DIR, "fake-claude-cli.ts");
export const FAKE_CODEX_CLI = join(TESTING_DIR, "fake-codex-app-server.ts");
export const SERVER_ENTRY = join(SERVER_DIR, "..", "index.ts");

export type ApiResult = { status: number; body: any };

export function harnessEnv(home: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    HOME: home,
    USERPROFILE: home,
    ...extra,
  };
}

export function writeHarnessConfig(home: string, instances: unknown, extraConfig: Record<string, unknown> = {}): void {
  mkdirSync(join(home, ".velarixbot"), { recursive: true });
  writeFileSync(join(home, ".velarixbot", "config.json"), JSON.stringify({ instances, ...extraConfig }));
}

export async function waitForHealth(base: string, child: ChildProcess, stderr: () => string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) return;
    } catch {
      /* not up */
    }
    if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr()}`);
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr()}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

export function bestEffortRm(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    /* Windows: a late child may still hold the temp home (EPERM) */
  }
}

export async function stopChild(child: ChildProcess | undefined): Promise<void> {
  if (!child) return;
  killProcessTree(child.pid);
  await new Promise<void>((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.on("close", () => resolve());
    setTimeout(() => {
      killProcessTree(child.pid);
      resolve();
    }, 5_000).unref?.();
  });
}

export function apiAt(base: string, token?: string) {
  return async (method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<ApiResult> => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(body ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
}

export interface SseFrame {
  kind?: string;
  event?: { type?: string; threadId?: string; ok?: boolean; source?: string; requestId?: string; requestType?: string; [k: string]: unknown };
  bot?: { id?: string; state?: string; busy?: boolean; name?: string; usage?: { input: number; output: number; cost: number | null }; threadParticipants?: string[]; messages?: unknown[] };
  botId?: string;
  threadId?: string;
  message?: { kind?: string; role?: string; text?: string; card?: { requestId?: string; options?: string[]; answered?: string; dismissed?: boolean; title?: string } };
  [k: string]: unknown;
}

export interface SseRecorder {
  frames: SseFrame[];
  until(pred: (frame: SseFrame) => boolean, timeoutMs?: number): Promise<SseFrame>;
  /** Like until(), but ignores frames at or before `after` (same-thread repeats). */
  untilAfter(after: SseFrame, pred: (frame: SseFrame) => boolean, timeoutMs?: number): Promise<SseFrame>;
  close(): void;
}

export async function connectSse(base: string, token?: string): Promise<SseRecorder> {
  const res = await fetch(`${base}/api/events`, {
    headers: token ? { authorization: `Bearer ${token}` } : undefined,
  });
  if (!res.ok || !res.body) throw new Error(`SSE ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const frames: SseFrame[] = [];
  const waiters: Array<{ pred: (f: SseFrame) => boolean; resolve: (f: SseFrame) => void }> = [];
  let buf = "";
  let closed = false;

  const deliver = (frame: SseFrame) => {
    frames.push(frame);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(frame)) {
        const [w] = waiters.splice(i, 1);
        w.resolve(frame);
      }
    }
  };

  const pump = async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        buf = buf.replace(/\r\n/g, "\n");
        let sep;
        while ((sep = buf.indexOf("\n\n")) !== -1) {
          const block = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          const data = block
            .split("\n")
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).trimStart())
            .join("\n");
          if (!data) continue;
          try {
            deliver(JSON.parse(data) as SseFrame);
          } catch {
            /* keep-alive or partial */
          }
        }
      }
    } catch {
      /* cancelled */
    }
  };
  void pump();

  const until = (pred: (frame: SseFrame) => boolean, timeoutMs = 15_000): Promise<SseFrame> => {
    const seen = frames.find(pred);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      const waiter = { pred, resolve: (f: SseFrame) => (clearTimeout(timer), resolve(f)) };
      const timer = setTimeout(() => {
        const idx = waiters.indexOf(waiter);
        if (idx !== -1) waiters.splice(idx, 1);
        const kinds = frames.map((f) => (f.kind === "runtime" ? `runtime:${f.event?.type}` : f.kind)).join(", ");
        reject(new Error(`no matching SSE frame within ${timeoutMs}ms; saw: ${kinds || "(none)"}`));
      }, timeoutMs);
      timer.unref?.();
      waiters.push(waiter);
    });
  };

  return {
    frames,
    until,
    untilAfter(after, pred, timeoutMs = 15_000) {
      const afterIdx = frames.indexOf(after);
      return until((f) => frames.indexOf(f) > afterIdx && pred(f), timeoutMs);
    },
    close() {
      if (closed) return;
      closed = true;
      void reader.cancel();
    },
  };
}

export async function untilFile(path: string, pred: (text: string) => boolean, timeoutMs = 10_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const text = readFileSync(path, "utf8");
      if (pred(text)) return text;
    } catch {
      /* not written yet */
    }
    if (Date.now() > deadline) throw new Error(`file ${path} never matched`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

export interface BootedHarness {
  base: string;
  home: string;
  /** Per-launch API token every /api/* call (except /api/health) requires. */
  token: string;
  api: ReturnType<typeof apiAt>;
  sse: SseRecorder;
  stop(): Promise<void>;
}

export async function bootHarness(opts: {
  instances: unknown;
  port?: number;
  env?: Record<string, string>;
  /** Extra top-level ~/.velarixbot/config.json keys (e.g. computer). */
  config?: Record<string, unknown>;
}): Promise<BootedHarness> {
  const port = opts.port ?? 18800 + Math.floor(Math.random() * 10_000);
  const base = `http://127.0.0.1:${port}`;
  const home = mkdtempSync(join(tmpdir(), "omb-harness-"));
  const token = `test-api-token-${port}`;
  writeHarnessConfig(home, opts.instances, opts.config ?? {});
  let stderr = "";
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: join(SERVER_DIR, "..", ".."),
    env: harnessEnv(home, { OMB_PORT: String(port), VELARIX_DEV_TOKEN: token, ...opts.env }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr!.on("data", (c) => (stderr += c));
  try {
    await waitForHealth(base, child, () => stderr);
  } catch (e) {
    await stopChild(child);
    bestEffortRm(home);
    throw e;
  }
  const sse = await connectSse(base, token);
  return {
    base,
    home,
    token,
    api: apiAt(base, token),
    sse,
    async stop() {
      sse.close();
      await stopChild(child);
      bestEffortRm(home);
    },
  };
}
