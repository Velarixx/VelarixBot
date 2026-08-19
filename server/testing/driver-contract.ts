// Provider-driver conformance suite (P1.4) — the behavioral contract every
// CLI-backed driver must pass, run against the scripted fake CLIs in this
// directory. One runner, thirteen scenarios:
//
//   start / resume / cancel / kill / permission / question / tool-order /
//   partial-output / unknown-event / usage / malformed / drift /
//   restart-mid-turn
//
// Two layers of assertion:
//   1. Invariants — hold for every driver on every scenario: the first event
//      is turn.started, exactly one turn.completed ends the stream, every
//      event carries the driver's own kind (the bus drops cross-driver
//      events), only canonical RuntimeEvent types appear, and hasSession()
//      is false once the turn settles. Never a hang.
//   2. Recorded fixtures — the normalized canonical event transcript of each
//      scenario, committed under testing/fixtures/driver-contract/. PRs are
//      deterministic: the suite replays the scripted fakes and compares
//      against the recording, so a driver that silently reorders, drops, or
//      double-emits events fails even when the invariants still hold. The
//      live protocol canaries (protocol-canary.yml / eval.yml) stay the
//      outer ring against real CLIs; this suite is the inner, hermetic ring.
//
// Re-record after an intentional behavior change:
//   DRIVER_CONTRACT_RECORD=1 pnpm test server/drivers/driver-contract.test.ts
//
// Normalization strips the non-deterministic base fields (eventId,
// createdAt, threadId, turnId, requestId) and volatile exit codes in
// runtime.error messages; everything discriminating stays.
//
// Lives in server/testing because it imports vitest (dev-only, unshipped).
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type { ProviderInstance, RuntimeEvent, SendTurnInput } from "../contracts.ts";
import { ensureDirs } from "../config.ts";
import { recordEvents, type EventRecorder } from "./events.ts";

export const DRIVER_CONTRACT_SCENARIOS = [
  "start",
  "resume",
  "cancel",
  "kill",
  "permission",
  "question",
  "tool-order",
  "partial-output",
  "unknown-event",
  "usage",
  "malformed",
  "drift",
  "restart-mid-turn",
] as const;
export type DriverContractScenario = (typeof DRIVER_CONTRACT_SCENARIOS)[number];

const CANONICAL_TYPES = new Set<RuntimeEvent["type"]>([
  "session.started",
  "session.exited",
  "turn.started",
  "turn.completed",
  "item.started",
  "item.updated",
  "item.completed",
  "content.delta",
  "request.opened",
  "request.resolved",
  "thread.token-usage.updated",
  "runtime.error",
]);

// ── fixture shapes ──────────────────────────────────────────────────────

export interface ScenarioContext {
  threadId: string;
  scratch: string;
  instance: ProviderInstance;
  recorder: EventRecorder;
}

type ActiveHandle = {
  constructor?: { name?: string };
  pid?: number;
  address?: () => unknown;
};

const activeHandles = (): ActiveHandle[] => {
  const getActiveHandles = (process as typeof process & { _getActiveHandles?: () => ActiveHandle[] })._getActiveHandles;
  return getActiveHandles?.call(process) ?? [];
};

const describeHandle = (handle: ActiveHandle): string => {
  const name = handle.constructor?.name ?? "unknown";
  const pid = typeof handle.pid === "number" ? ` pid=${handle.pid}` : "";
  let address = "";
  try {
    const value = handle.address?.();
    if (value) address = ` address=${JSON.stringify(value)}`;
  } catch {
    // A closing socket can reject address(); its identity is still useful.
  }
  return `${name}${pid}${address}`;
};

/** Driver disposal starts Windows taskkill asynchronously. Wait for the
 * actual child/pipe/socket handles to disappear before deleting their cwd.
 * A timeout is a contract failure with the surviving resources named; it is
 * never converted into an rm retry or an ignored EPERM. */
async function expectDriverHandlesClosed(baseline: ReadonlySet<ActiveHandle>, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const remaining = activeHandles().filter((handle) => !baseline.has(handle));
    if (remaining.length === 0) return;
    if (Date.now() >= deadline) {
      throw new Error(`${label} leaked active handles after dispose: ${remaining.map(describeHandle).join(", ")}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

/** process.env for the fake CLI (FAKE_*_MODE, dumps). A function form gets
 * the per-scenario scratch dir, for dump file paths. */
type EnvSpec = Record<string, string> | ((ctx: { scratch: string }) => Record<string, string>);

interface Arrange {
  env?: EnvSpec;
  /** Extra SendTurnInput fields merged onto the scenario's turn. */
  turn?: Partial<SendTurnInput>;
}

/** A scenario the driver has no protocol surface for. The runner registers
 * a skipped test carrying the reason — absence is documented, not silent. */
export type Unsupported = { unsupported: string };
const isUnsupported = (s: unknown): s is Unsupported =>
  typeof (s as Unsupported)?.unsupported === "string";

export interface DriverContractFixtures {
  /** Must match the created instance's driverKind; names the fixture file. */
  driverKind: string;
  /** Assistant text a scripted happy turn settles with. */
  finalText: string;
  scenarios: {
    start: Arrange;
    resume: Arrange & { cursor: string };
    /** interruptTurn while in flight; wait for `after` before interrupting. */
    cancel: Arrange & { after: RuntimeEvent["type"] };
    /** stopAll while in flight; wait for `after` before killing. */
    kill: Arrange & { after: RuntimeEvent["type"] };
    permission:
      | (Arrange & {
          /** Open the ask out-of-band (claude's socket broker). Runs after
           * session.started; returns a cleanup. */
          raise?: (ctx: ScenarioContext) => Promise<() => void | Promise<void>>;
          expectTool: string;
          /** Brokers that leave the CLI turn open (claude hang) need an
           * interrupt to end the turn after the ask resolves. */
          interruptToEnd?: boolean;
        })
      | Unsupported;
    question:
      | (Arrange & {
          /** "carded": request.opened(question) → respondToRequest(answer).
           * "auto-answered": the driver answers in-band; no card may open. */
          style: "carded";
          raise?: (ctx: ScenarioContext) => Promise<() => void | Promise<void>>;
          expectTool: string;
          answer: string;
          interruptToEnd?: boolean;
        })
      | (Arrange & { style: "auto-answered"; verify?: (ctx: ScenarioContext) => void | Promise<void> })
      | Unsupported;
    "tool-order": Arrange;
    "partial-output": Arrange & { deltas: string[] };
    "unknown-event": Arrange;
    usage: Arrange & { expect: { input: number; output: number } };
    malformed: Arrange;
    drift:
      | (Arrange & {
          /** Codex surfaces drift as runtime.error; ACP replies silently. */
          expectRuntimeError?: boolean;
          verify?: (ctx: ScenarioContext) => void | Promise<void>;
        })
      | Unsupported;
    "restart-mid-turn": {
      /** Arrangement that makes the CLI die mid-turn (crash-mid-turn mode).
       * The runner then clears it and sends a second, happy turn on the
       * same thread — the driver must recover, not wedge. */
      crash: Arrange;
    };
  };
}

export interface RunProviderDriverContractOptions {
  /** Create a fresh driver instance wired to its scripted fake CLI. Called
   * once per scenario — no cross-scenario state. */
  createDriver: () => Promise<ProviderInstance>;
  fixtures: DriverContractFixtures;
}

// ── normalization ───────────────────────────────────────────────────────

export type NormalizedEvent = Record<string, unknown> & { type: RuntimeEvent["type"] };

/** Volatile exit codes (SIGKILL is null on POSIX, a code on Windows) must
 * not make a recording platform-specific. */
const normalizeMessage = (message: string) => message.replace(/exited (-?\d+|null)/g, "exited <code>");

/** Some drivers mint a fresh UUID session id per turn (claude's
 * --session-id); stable provider-native ids (codex-thread-1, …) stay. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const normalizeSessionId = (sessionId: string | null) =>
  sessionId !== null && UUID_RE.test(sessionId) ? "<uuid>" : sessionId;

export function normalizeEvent(e: RuntimeEvent): NormalizedEvent {
  const n: NormalizedEvent = { type: e.type };
  const pick = (key: string, value: unknown) => {
    if (value !== undefined) n[key] = value;
  };
  switch (e.type) {
    case "session.started":
      pick("sessionId", normalizeSessionId(e.sessionId));
      pick("model", e.model ?? null);
      break;
    case "session.exited":
      pick("reason", e.reason);
      break;
    case "turn.started":
      break;
    case "turn.completed":
      pick("ok", e.ok);
      pick("stopReason", e.stopReason ?? null);
      pick("cost", e.cost ?? null);
      pick("denials", e.denials);
      break;
    case "item.started":
    case "item.updated":
    case "item.completed":
      pick("itemType", e.itemType);
      pick("itemId", e.itemId);
      pick("title", (e as { title?: string }).title);
      pick("tokens", (e as { tokens?: number | null }).tokens);
      pick("ok", (e as { ok?: boolean }).ok);
      pick("text", (e as { text?: string }).text);
      break;
    case "content.delta":
      pick("streamKind", e.streamKind);
      pick("delta", e.delta);
      break;
    case "request.opened":
      pick("requestType", e.requestType);
      pick("tool", e.tool);
      pick("summary", e.summary);
      pick("choices", e.choices);
      break;
    case "request.resolved":
      pick("behavior", e.behavior);
      pick("source", e.source);
      break;
    case "thread.token-usage.updated":
      pick("input", e.input);
      pick("output", e.output);
      break;
    case "runtime.error":
      pick("message", normalizeMessage(e.message));
      break;
  }
  return n;
}

// ── recorded fixture files ──────────────────────────────────────────────

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "driver-contract");
const RECORDING = process.env.DRIVER_CONTRACT_RECORD === "1";

const fixtureFile = (driverKind: string) => join(FIXTURES_DIR, `${driverKind}.json`);

interface FixtureDocument {
  driverKind: string;
  scenarios: Partial<Record<DriverContractScenario, NormalizedEvent[]>>;
}

function readFixtureDocument(driverKind: string): FixtureDocument | null {
  try {
    return JSON.parse(readFileSync(fixtureFile(driverKind), "utf8")) as FixtureDocument;
  } catch {
    return null;
  }
}

function checkRecorded(driverKind: string, scenario: DriverContractScenario, events: RuntimeEvent[]): void {
  const normalized = events.map(normalizeEvent);
  if (RECORDING) {
    const doc = readFixtureDocument(driverKind) ?? { driverKind, scenarios: {} };
    doc.driverKind = driverKind;
    doc.scenarios[scenario] = normalized;
    // stable scenario order, so re-recordings diff cleanly
    const ordered: FixtureDocument = { driverKind, scenarios: {} };
    for (const name of DRIVER_CONTRACT_SCENARIOS) {
      if (doc.scenarios[name]) ordered.scenarios[name] = doc.scenarios[name];
    }
    mkdirSync(FIXTURES_DIR, { recursive: true });
    writeFileSync(fixtureFile(driverKind), JSON.stringify(ordered, null, 2) + "\n");
    return;
  }
  const doc = readFixtureDocument(driverKind);
  const recorded = doc?.scenarios[scenario];
  if (!recorded) {
    throw new Error(
      `no recorded fixture for ${driverKind}/${scenario} — run DRIVER_CONTRACT_RECORD=1 pnpm test server/drivers/driver-contract.test.ts and commit ${fixtureFile(driverKind)}`,
    );
  }
  expect(normalized).toEqual(recorded);
}

// ── invariants ──────────────────────────────────────────────────────────

/** Split a multi-turn transcript into per-turn slices at turn.completed. */
function turnSlices(events: RuntimeEvent[]): RuntimeEvent[][] {
  const slices: RuntimeEvent[][] = [];
  let current: RuntimeEvent[] = [];
  for (const e of events) {
    current.push(e);
    if (e.type === "turn.completed") {
      slices.push(current);
      current = [];
    }
  }
  if (current.length) slices.push(current);
  return slices;
}

function assertInvariants(events: RuntimeEvent[], driverKind: string, threadId: string): void {
  expect(events.length).toBeGreaterThan(0);
  for (const e of events) {
    expect(e.provider, `event ${e.type} carries a foreign driverKind`).toBe(driverKind);
    expect(e.threadId, `event ${e.type} carries a foreign threadId`).toBe(threadId);
    expect(e.eventId).toBeTruthy();
    expect(e.createdAt).toBeTruthy();
    expect(e.turnId).toBeTruthy();
    expect(CANONICAL_TYPES.has(e.type), `non-canonical event type ${e.type}`).toBe(true);
  }
  for (const slice of turnSlices(events)) {
    expect(slice[0].type, "a turn must open with turn.started").toBe("turn.started");
    const last = slice.at(-1)!;
    expect(last.type, "a turn must end with exactly one turn.completed").toBe("turn.completed");
    // one turnId per turn — no interleaving
    expect(new Set(slice.map((e) => e.turnId)).size).toBe(1);
  }
}

// ── env plumbing ────────────────────────────────────────────────────────

/** The fake CLIs read their FAKE_* toggles from the child env, which every
 * driver builds from process.env — set, then restore. The suite runs with
 * fileParallelism off, so this is race-free. */
function pushEnv(env: Record<string, string>): () => void {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) {
    saved.set(key, process.env[key]);
    process.env[key] = value;
  }
  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

const resolveEnv = (env: EnvSpec | undefined, scratch: string): Record<string, string> =>
  typeof env === "function" ? env({ scratch }) : (env ?? {});

// ── the runner ──────────────────────────────────────────────────────────

export function runProviderDriverContract(options: RunProviderDriverContractOptions): void {
  const { createDriver, fixtures } = options;
  const { driverKind } = fixtures;

  // fresh instance + recorder + scratch dir per scenario, no cross-test state
  const withInstance = async (
    scenario: DriverContractScenario,
    threadId: string,
    arrange: Arrange,
    run: (ctx: ScenarioContext) => Promise<void>,
  ): Promise<void> => {
    ensureDirs();
    const scratch = mkdtempSync(join(tmpdir(), "omb-driver-contract-"));
    const restoreEnv = pushEnv(resolveEnv(arrange.env, scratch));
    const baselineHandles = new Set(activeHandles());
    let instance: ProviderInstance | undefined;
    let recorder: EventRecorder | undefined;
    try {
      instance = await createDriver();
      expect(instance.driverKind).toBe(driverKind);
      recorder = recordEvents(instance.adapter);
      await run({ threadId, scratch, instance, recorder });
      assertInvariants(recorder.events, driverKind, threadId);
      expect(instance.adapter.hasSession(threadId), "the thread must settle — never a wedge").toBe(false);
      checkRecorded(driverKind, scenario, recorder.events);
    } finally {
      recorder?.stop();
      restoreEnv();
      await instance?.dispose();
      await expectDriverHandlesClosed(baselineHandles, `${driverKind}/${scenario}`);
      rmSync(scratch, { recursive: true, force: true });
    }
  };

  const sendTurn = (ctx: ScenarioContext, extra?: Partial<SendTurnInput>) =>
    ctx.instance.adapter.sendTurn({ threadId: ctx.threadId, text: "contract turn", cwd: ctx.scratch, ...extra });
  const untilCompleted = (ctx: ScenarioContext) => ctx.recorder.until((e) => e.type === "turn.completed");
  const assistantSettles = (ctx: ScenarioContext) =>
    ctx.recorder.events.filter((e) => e.type === "item.completed" && (e as { itemType?: string }).itemType === "assistant_text");

  describe(`ProviderDriver contract: ${driverKind}`, () => {
    const s = fixtures.scenarios;

    it("start: a first turn lands the canonical happy sequence", () =>
      withInstance("start", "ct-start", s.start, async (ctx) => {
        const { turnId } = await sendTurn(ctx, s.start.turn);
        const done = await untilCompleted(ctx);
        expect(done).toMatchObject({ ok: true });
        expect(ctx.recorder.events.every((e) => e.turnId === turnId)).toBe(true);
        expect(ctx.recorder.events.filter((e) => e.type === "session.started")).toHaveLength(1);
        const settled = assistantSettles(ctx);
        expect(settled).toHaveLength(1);
        expect((settled[0] as { text: string }).text).toBe(fixtures.finalText);
      }));

    it("resume: a resumeCursor lands back on the same provider session", () =>
      withInstance("resume", "ct-resume", s.resume, async (ctx) => {
        await sendTurn(ctx, { resumeCursor: s.resume.cursor, ...s.resume.turn });
        const started = await ctx.recorder.until((e) => e.type === "session.started");
        expect(started).toMatchObject({ sessionId: s.resume.cursor });
        const done = await untilCompleted(ctx);
        expect(done).toMatchObject({ ok: true });
      }));

    it("cancel: interruptTurn settles an in-flight turn — never a hang", () =>
      withInstance("cancel", "ct-cancel", s.cancel, async (ctx) => {
        await sendTurn(ctx, s.cancel.turn);
        await ctx.recorder.until((e) => e.type === s.cancel.after);
        await ctx.instance.adapter.interruptTurn(ctx.threadId);
        await untilCompleted(ctx);
      }));

    it("kill: stopAll settles every in-flight turn — never a hang", () =>
      withInstance("kill", "ct-kill", s.kill, async (ctx) => {
        await sendTurn(ctx, s.kill.turn);
        await ctx.recorder.until((e) => e.type === s.kill.after);
        await ctx.instance.adapter.stopAll();
        await untilCompleted(ctx);
      }));

    if (isUnsupported(s.permission)) {
      it.skip(`permission: not applicable — ${s.permission.unsupported}`, () => {});
    } else {
      const fx = s.permission;
      it("permission: an ask opens a card, allow resolves it, the turn completes", () =>
        withInstance("permission", "ct-perm", fx, async (ctx) => {
          await sendTurn(ctx, fx.turn);
          let cleanup: (() => void | Promise<void>) | undefined;
          try {
            if (fx.raise) {
              await ctx.recorder.until((e) => e.type === "session.started");
              cleanup = await fx.raise(ctx);
            }
            const opened = await ctx.recorder.until((e) => e.type === "request.opened");
            expect(opened).toMatchObject({ requestType: "permission", tool: fx.expectTool });
            await ctx.instance.adapter.respondToRequest(ctx.threadId, opened.requestId!, { behavior: "allow" });
            const resolved = await ctx.recorder.until((e) => e.type === "request.resolved");
            expect(resolved).toMatchObject({ behavior: "allow", source: "user" });
          } finally {
            await cleanup?.();
          }
          if (fx.interruptToEnd) await ctx.instance.adapter.interruptTurn(ctx.threadId);
          await untilCompleted(ctx);
        }));
    }

    if (isUnsupported(s.question)) {
      it.skip(`question: not applicable — ${s.question.unsupported}`, () => {});
    } else if (s.question.style === "carded") {
      const fx = s.question;
      it("question: an ask opens a question card and the answer flows back", () =>
        withInstance("question", "ct-quest", fx, async (ctx) => {
          await sendTurn(ctx, fx.turn);
          let cleanup: (() => void | Promise<void>) | undefined;
          try {
            if (fx.raise) {
              await ctx.recorder.until((e) => e.type === "session.started");
              cleanup = await fx.raise(ctx);
            }
            const opened = await ctx.recorder.until((e) => e.type === "request.opened");
            expect(opened).toMatchObject({ requestType: "question", tool: fx.expectTool });
            await ctx.instance.adapter.respondToRequest(ctx.threadId, opened.requestId!, {
              behavior: "answer",
              message: fx.answer,
            });
            const resolved = await ctx.recorder.until((e) => e.type === "request.resolved");
            expect(resolved).toMatchObject({ behavior: "answer", source: "user" });
          } finally {
            await cleanup?.();
          }
          if (fx.interruptToEnd) await ctx.instance.adapter.interruptTurn(ctx.threadId);
          await untilCompleted(ctx);
        }));
    } else {
      const fx = s.question;
      it("question: a conversational ask is auto-answered — never a card, never a wedge", () =>
        withInstance("question", "ct-quest", fx, async (ctx) => {
          await sendTurn(ctx, fx.turn);
          const done = await untilCompleted(ctx);
          expect(done).toMatchObject({ ok: true });
          expect(ctx.recorder.events.some((e) => e.type === "request.opened")).toBe(false);
          expect(ctx.recorder.events.some((e) => e.type === "request.resolved")).toBe(false);
          await fx.verify?.(ctx);
        }));
    }

    it("tool-order: tool items start before they complete, inside the turn", () =>
      withInstance("tool-order", "ct-tools", s["tool-order"], async (ctx) => {
        await sendTurn(ctx, s["tool-order"].turn);
        const done = await untilCompleted(ctx);
        expect(done).toMatchObject({ ok: true });
        const events = ctx.recorder.events;
        const completions = events.filter(
          (e) => e.type === "item.completed" && (e as { itemType?: string }).itemType === "tool",
        );
        expect(completions.length).toBeGreaterThan(0);
        for (const completed of completions) {
          const startIdx = events.findIndex(
            (e) => e.type === "item.started" && (e as { itemType?: string }).itemType === "tool" && e.itemId === completed.itemId,
          );
          expect(startIdx, `tool ${completed.itemId} completed without starting`).toBeGreaterThanOrEqual(0);
          expect(startIdx).toBeLessThan(events.indexOf(completed));
        }
      }));

    it("partial-output: deltas stream once and the settled text is their sum", () =>
      withInstance("partial-output", "ct-part", s["partial-output"], async (ctx) => {
        await sendTurn(ctx, s["partial-output"].turn);
        const done = await untilCompleted(ctx);
        expect(done).toMatchObject({ ok: true });
        const deltas = ctx.recorder.events
          .filter((e) => e.type === "content.delta" && (e as { streamKind?: string }).streamKind === "assistant_text")
          .map((e) => (e as { delta: string }).delta);
        expect(deltas).toEqual(s["partial-output"].deltas);
        const settled = assistantSettles(ctx);
        expect(settled).toHaveLength(1);
        expect((settled[0] as { text: string }).text).toBe(deltas.join(""));
      }));

    it("unknown-event: unrecognized protocol frames are skipped, not fatal", () =>
      withInstance("unknown-event", "ct-unkev", s["unknown-event"], async (ctx) => {
        await sendTurn(ctx, s["unknown-event"].turn);
        const done = await untilCompleted(ctx);
        expect(done).toMatchObject({ ok: true });
        expect(ctx.recorder.events.some((e) => e.type === "runtime.error")).toBe(false);
      }));

    it("usage: token usage lands as thread.token-usage.updated", () =>
      withInstance("usage", "ct-usage", s.usage, async (ctx) => {
        await sendTurn(ctx, s.usage.turn);
        const done = await untilCompleted(ctx);
        expect(done).toMatchObject({ ok: true });
        const usage = ctx.recorder.events.find((e) => e.type === "thread.token-usage.updated");
        expect(usage).toMatchObject(s.usage.expect);
      }));

    it("malformed: garbage protocol lines are skipped without losing the turn", () =>
      withInstance("malformed", "ct-malf", s.malformed, async (ctx) => {
        await sendTurn(ctx, s.malformed.turn);
        const done = await untilCompleted(ctx);
        expect(done).toMatchObject({ ok: true });
      }));

    if (isUnsupported(s.drift)) {
      it.skip(`drift: not applicable — ${s.drift.unsupported}`, () => {});
    } else {
      const fx = s.drift;
      it("drift: an unknown server request is refused, never a fabricated approval", () =>
        withInstance("drift", "ct-drift", fx, async (ctx) => {
          await sendTurn(ctx, fx.turn);
          const done = await untilCompleted(ctx);
          expect(done).toMatchObject({ ok: true });
          expect(ctx.recorder.events.some((e) => e.type === "request.opened")).toBe(false);
          expect(ctx.recorder.events.some((e) => e.type === "runtime.error")).toBe(fx.expectRuntimeError === true);
          await fx.verify?.(ctx);
        }));
    }

    it("restart-mid-turn: a CLI death fails the turn cleanly and the next turn recovers", () =>
      withInstance("restart-mid-turn", "ct-restart", {}, async (ctx) => {
        const crash = s["restart-mid-turn"].crash;
        const restoreCrashEnv = pushEnv(resolveEnv(crash.env, ctx.scratch));
        try {
          await sendTurn(ctx, crash.turn);
          const died = await untilCompleted(ctx);
          expect(died).toMatchObject({ ok: false });
          expect(ctx.recorder.events.some((e) => e.type === "runtime.error")).toBe(true);
          expect(ctx.instance.adapter.hasSession(ctx.threadId)).toBe(false);
        } finally {
          restoreCrashEnv();
        }
        await sendTurn(ctx);
        const done = await ctx.recorder.until(
          (e) =>
            e.type === "turn.completed" &&
            ctx.recorder.events.filter((x) => x.type === "turn.completed").length === 2,
        );
        expect(done).toMatchObject({ ok: true });
        const settled = assistantSettles(ctx);
        expect((settled.at(-1) as { text: string } | undefined)?.text).toBe(fixtures.finalText);
      }));
  });
}
