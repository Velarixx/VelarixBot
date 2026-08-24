// P6 lane scheduler — sits in front of startTurn. Does not replace the
// turn service, routine_runs claims, or interruption recovery.
//
// Lanes: user (interactive chat), channel (Discord/Telegram inbound),
// agent (bot-to-bot), background (routines / thenStartTurn). Fairness is
// round-robin across lanes so one lane cannot starve another. Default is
// one running turn per bot. Durable SQLite keys dedupe retries.
//
// Request lineage (P7) is layered on top: this scheduler passes a
// caller-supplied requestId through to startTurn and does not mint one.
import { newId } from "../contracts.ts";
import {
  SCHEDULER_LANES,
  type LaneIdempotencyRepository,
  type SchedulerLane,
} from "../repositories/lanes.ts";
import type { Broadcast } from "./events.ts";

/** Same shape as StartTurnOpts plus the scheduler-only idempotency key.
 * Defined here so this module does not import the turn service. */
export interface LaneTurnOpts {
  commsDepth?: number;
  attachments?: Array<{ path: string; mime?: string }>;
  visited?: string[];
  groupThreadId?: string;
  extraSkillIds?: string[];
  unattended?: boolean;
  systemNote?: string;
  autonomyContinue?: boolean;
  idempotencyKey?: string;
  /** P7 lineage id. Passed through to startTurn; this module does not mint it. */
  requestId?: string;
}

export { SCHEDULER_LANES, type SchedulerLane };

export type LaneWorkStatus = "queued" | "running" | "cancelled";

export interface LaneWorkSnapshot {
  workId: string;
  lane: SchedulerLane;
  botId: string;
  status: LaneWorkStatus;
  queuedAt: number;
  idempotencyKey?: string;
  reason?: string;
}

export interface LaneSchedulerSnapshot {
  queued: LaneWorkSnapshot[];
  running: LaneWorkSnapshot[];
  cancelled: LaneWorkSnapshot[];
}

export interface LaneEnqueueInput {
  lane: SchedulerLane;
  botId: string;
  text: string;
  opts?: LaneTurnOpts;
  idempotencyKey?: string;
  /** Override the default `startTurn` dispatch (agent hops wait for a reply). */
  run?: () => Promise<unknown>;
}

export interface LaneEnqueueResult {
  workId: string;
  lane: SchedulerLane;
  botId: string;
  status: "queued" | "running" | "duplicate" | "cancelled";
  started?: { threadId: string; messageId: string };
  requestId?: string;
  settled: Promise<unknown>;
}

export interface LaneCancelFilter {
  workId?: string;
  botId?: string;
  lane?: SchedulerLane;
}

export interface LaneScheduler {
  enqueue(input: LaneEnqueueInput): Promise<LaneEnqueueResult>;
  cancel(filter: LaneCancelFilter): Promise<{ cancelled: LaneWorkSnapshot[] }>;
  snapshot(): LaneSchedulerSnapshot;
  noteIdle(botId: string): void;
}

const CANCELLED_KEEP = 50;

interface LaneItem {
  workId: string;
  lane: SchedulerLane;
  botId: string;
  text: string;
  opts?: LaneTurnOpts;
  idempotencyKey?: string;
  run?: () => Promise<unknown>;
  status: LaneWorkStatus;
  queuedAt: number;
  reason?: string;
  started?: { threadId: string; messageId: string };
  startedGate: { resolve: (value: { threadId: string; messageId: string } | undefined) => void; promise: Promise<{ threadId: string; messageId: string } | undefined> };
  settledGate: { resolve: (value: unknown) => void; reject: (error: Error) => void; promise: Promise<unknown> };
}

function deferred<T>(): { resolve: (value: T) => void; reject: (error: Error) => void; promise: Promise<T> } {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { resolve, reject, promise };
}

function isTurnStart(value: unknown): value is { threadId: string; messageId: string } {
  if (!value || typeof value !== "object") return false;
  const rec = value as { threadId?: unknown; messageId?: unknown };
  return typeof rec.threadId === "string" && typeof rec.messageId === "string";
}

  function snapshotOf(item: LaneItem): LaneWorkSnapshot {
  return {
    workId: item.workId,
    lane: item.lane,
    botId: item.botId,
    status: item.status,
    queuedAt: item.queuedAt,
    ...(item.idempotencyKey ? { idempotencyKey: item.idempotencyKey } : {}),
    ...(item.reason ? { reason: item.reason } : {}),
  };
}

function requestIdOf(opts?: LaneTurnOpts): string | undefined {
  const id = typeof opts?.requestId === "string" ? opts.requestId.trim() : "";
  return id || undefined;
}

function turnOptsForLane(lane: SchedulerLane, opts?: LaneTurnOpts): LaneTurnOpts | undefined {
  const { idempotencyKey: _key, ...rest } = opts ?? {};
  const base = Object.keys(rest).length ? rest : undefined;
  // Channel inbound never inherits standing approvals — force the
  // unattended mark. Interactive user turns drop any inherited mark.
  if (lane === "channel") return { ...base, unattended: true };
  if (lane === "user") {
    if (!base) return undefined;
    const { unattended: _drop, ...userOpts } = base;
    return Object.keys(userOpts).length ? userOpts : undefined;
  }
  return base;
}

export function createLaneScheduler(deps: {
  keys: LaneIdempotencyRepository;
  broadcast: Broadcast;
  startTurn: (botId: string, text: string, opts?: LaneTurnOpts) => Promise<{ threadId: string; messageId: string }>;
  interrupt: (botId: string) => Promise<{ ok: true } | { error: string; status: number }>;
  isBusy: (botId: string) => boolean;
  now?: () => number;
}): LaneScheduler {
  const now = deps.now ?? (() => Date.now());
  const queues = new Map<SchedulerLane, LaneItem[]>(SCHEDULER_LANES.map((lane) => [lane, []]));
  const running = new Map<string, LaneItem>();
  const cancelled: LaneItem[] = [];
  const idleWaiters = new Set<(botId: string) => void>();
  let cursor = -1;
  let pumping = false;

  function emit(item: LaneItem): void {
    const requestId = requestIdOf(item.opts);
    deps.broadcast({
      kind: "lane",
      workId: item.workId,
      lane: item.lane,
      botId: item.botId,
      status: item.status,
      ...(item.idempotencyKey ? { idempotencyKey: item.idempotencyKey } : {}),
      ...(requestId ? { requestId } : {}),
      ...(item.reason ? { reason: item.reason } : {}),
    });
  }

  function persist(item: LaneItem, status: "queued" | "running" | "cancelled" | "done"): void {
    if (!item.idempotencyKey) return;
    try {
      deps.keys.setStatus(item.idempotencyKey, status);
    } catch {
      // a closed test database must not reject a settling dispatch
    }
  }

  function rememberCancelled(item: LaneItem): void {
    cancelled.unshift(item);
    if (cancelled.length > CANCELLED_KEEP) cancelled.length = CANCELLED_KEEP;
  }

  function removeQueued(item: LaneItem): boolean {
    const q = queues.get(item.lane);
    if (!q) return false;
    const idx = q.indexOf(item);
    if (idx === -1) return false;
    q.splice(idx, 1);
    return true;
  }

  function waitIdle(botId: string): Promise<void> {
    if (!deps.isBusy(botId)) return Promise.resolve();
    return new Promise((resolve) => {
      const listener = (id: string) => {
        if (id !== botId) return;
        if (deps.isBusy(botId)) return;
        idleWaiters.delete(listener);
        resolve();
      };
      idleWaiters.add(listener);
    });
  }

  function pickNext(): LaneItem | null {
    for (let step = 1; step <= SCHEDULER_LANES.length; step++) {
      const lane = SCHEDULER_LANES[(cursor + step) % SCHEDULER_LANES.length];
      const q = queues.get(lane)!;
      const idx = q.findIndex((item) => !running.has(item.botId) && !deps.isBusy(item.botId));
      if (idx === -1) continue;
      const [item] = q.splice(idx, 1);
      cursor = (cursor + step) % SCHEDULER_LANES.length;
      return item;
    }
    return null;
  }

  async function dispatch(item: LaneItem): Promise<void> {
    item.status = "running";
    running.set(item.botId, item);
    persist(item, "running");
    emit(item);
    try {
      const run = item.run ?? (() => deps.startTurn(item.botId, item.text, item.opts));
      const result = await run();
      if (isTurnStart(result)) item.started = result;
      item.startedGate.resolve(item.started);
      if (deps.isBusy(item.botId) && running.get(item.botId) === item) {
        await waitIdle(item.botId);
      }
      if (item.status !== "running") return;
      persist(item, "done");
      item.settledGate.resolve(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (item.status === "running") {
        item.status = "cancelled";
        item.reason = message;
        persist(item, "cancelled");
        rememberCancelled(item);
        emit(item);
      }
      item.startedGate.resolve(item.started);
      item.settledGate.reject(error instanceof Error ? error : new Error(message));
    } finally {
      if (running.get(item.botId) === item) running.delete(item.botId);
      queueMicrotask(pump);
    }
  }

  function pump(): void {
    if (pumping) return;
    pumping = true;
    try {
      while (true) {
        const item = pickNext();
        if (!item) return;
        void dispatch(item);
      }
    } finally {
      pumping = false;
    }
  }

  function markCancelled(item: LaneItem, reason: string): boolean {
    if (item.status === "cancelled") return false;
    const wasRunning = item.status === "running";
    item.status = "cancelled";
    item.reason = reason;
    removeQueued(item);
    if (running.get(item.botId) === item) running.delete(item.botId);
    persist(item, "cancelled");
    rememberCancelled(item);
    emit(item);
    item.startedGate.resolve(item.started);
    item.settledGate.reject(new Error(reason));
    return wasRunning;
  }

  return {
    async enqueue(input) {
      const botId = String(input.botId ?? "").trim();
      if (!botId) throw Object.assign(new Error("bot id required"), { status: 400 });
      if (!(SCHEDULER_LANES as readonly string[]).includes(input.lane)) {
        throw Object.assign(new Error("unknown scheduler lane"), { status: 400 });
      }
      const workId = newId();
      const queuedAt = now();
      const key = typeof input.idempotencyKey === "string" ? input.idempotencyKey.trim() : "";
      if (key) {
        const claimed = deps.keys.claim({
          key,
          workId,
          lane: input.lane,
          botId,
          createdAt: queuedAt,
        });
        if (!claimed.created) {
          return {
            workId: claimed.row.workId,
            lane: claimed.row.lane,
            botId: claimed.row.botId,
            status: "duplicate",
            ...(requestIdOf(input.opts) ? { requestId: requestIdOf(input.opts) } : {}),
            settled: Promise.resolve(undefined),
          };
        }
      }
      const startedGate = deferred<{ threadId: string; messageId: string } | undefined>();
      const settledGate = deferred<unknown>();
      // keep settled from becoming an unhandled rejection when callers
      // only wait for accept (HTTP / channel inbound)
      settledGate.promise.catch(() => {});
      const item: LaneItem = {
        workId,
        lane: input.lane,
        botId,
        text: input.text,
        opts: turnOptsForLane(input.lane, input.opts),
        ...(key ? { idempotencyKey: key } : {}),
        ...(input.run ? { run: input.run } : {}),
        status: "queued",
        queuedAt,
        startedGate: { resolve: startedGate.resolve, promise: startedGate.promise },
        settledGate: { resolve: settledGate.resolve, reject: settledGate.reject, promise: settledGate.promise },
      };
      queues.get(input.lane)!.push(item);
      emit(item);
      pump();
      if (item.status === "running" || running.get(botId) === item) {
        const started = await item.startedGate.promise;
        return {
          workId: item.workId,
          lane: item.lane,
          botId: item.botId,
          status: item.status === "cancelled" ? "cancelled" : "running",
          ...(started ? { started } : {}),
          ...(requestIdOf(item.opts) ? { requestId: requestIdOf(item.opts) } : {}),
          settled: item.settledGate.promise,
        };
      }
      return {
        workId: item.workId,
        lane: item.lane,
        botId: item.botId,
        status: item.status === "cancelled" ? "cancelled" : "queued",
        ...(requestIdOf(item.opts) ? { requestId: requestIdOf(item.opts) } : {}),
        settled: item.settledGate.promise,
      };
    },
    async cancel(filter) {
      const workId = typeof filter.workId === "string" ? filter.workId.trim() : "";
      const botId = typeof filter.botId === "string" ? filter.botId.trim() : "";
      const lane = filter.lane;
      if (!workId && !botId && !lane) {
        throw Object.assign(new Error("workId, botId, or lane required"), { status: 400 });
      }
      const matches = (item: LaneItem): boolean => {
        if (workId && item.workId !== workId) return false;
        if (botId && item.botId !== botId) return false;
        if (lane && item.lane !== lane) return false;
        return true;
      };
      const dropped: LaneWorkSnapshot[] = [];
      const interruptBots = new Set<string>();
      for (const q of queues.values()) {
        for (const item of [...q]) {
          if (!matches(item) || item.status !== "queued") continue;
          markCancelled(item, "cancelled: dropped from queue");
          dropped.push(snapshotOf(item));
        }
      }
      for (const item of [...running.values()]) {
        if (!matches(item) || item.status !== "running") continue;
        if (markCancelled(item, "cancelled: interrupted running turn")) {
          interruptBots.add(item.botId);
          dropped.push(snapshotOf(item));
        }
      }
      for (const id of interruptBots) {
        await deps.interrupt(id);
      }
      return { cancelled: dropped };
    },
    snapshot() {
      const queued: LaneWorkSnapshot[] = [];
      for (const lane of SCHEDULER_LANES) {
        for (const item of queues.get(lane)!) queued.push(snapshotOf(item));
      }
      queued.sort((a, b) => a.queuedAt - b.queuedAt || a.workId.localeCompare(b.workId));
      return {
        queued,
        running: [...running.values()].map(snapshotOf),
        cancelled: cancelled.map(snapshotOf),
      };
    },
    noteIdle(botId) {
      for (const listener of [...idleWaiters]) listener(botId);
      queueMicrotask(pump);
    },
  };
}

/** Peel the scheduler-only key off startTurn opts. startTurn ignores it. */
export function splitLaneTurnOpts(opts?: LaneTurnOpts): {
  turnOpts?: LaneTurnOpts;
  idempotencyKey?: string;
} {
  if (!opts) return {};
  const { idempotencyKey, ...turnOpts } = opts;
  const key = typeof idempotencyKey === "string" && idempotencyKey.trim() ? idempotencyKey.trim() : undefined;
  return { turnOpts, ...(key ? { idempotencyKey: key } : {}) };
}
