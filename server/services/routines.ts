// Routine domain + scheduler. Fake-clock friendly like proactive.ts: the
// service takes `now` and the caller ticks — no timers, no sleeps in here.
//
// Durable runs (P1.2): every attempt lands in routine_runs with an explicit
// status. A scheduled occurrence is claimed under an idempotency key, so a
// crash between "run row written" and "schedule advanced" can never replay
// the same occurrence. While a run is live its lease is renewed every tick;
// a lease that lapses (the process died mid-run) is recovered on the next
// tick and the run closes as interrupted — no double-run, no wedged
// routine. Occurrences that came due while VelarixBot was closed or asleep
// are handled by the routine's missed policy: skip, run-once (default,
// the historical behavior), or catch-up (each missed occurrence in order,
// capped). Skips always record why.
import type { Repositories } from "../repositories/index.ts";
import type { RoutineRun } from "../repositories/routines.ts";
import type { SkillRecord } from "../teach.ts";
import {
  nextRunAt,
  parseMissedPolicy,
  parseRoutineSchedule,
  validThenStartTurn,
  type RoutineRecord,
  type RoutineSchedule,
  type ThenStartTurn,
} from "../store.ts";
import { newId } from "../contracts.ts";
import { localTimeZone } from "../timezone.ts";
import type { Broadcast } from "./events.ts";

/** How long a running row stays valid without renewal. Renewed every tick
 * (15s in production), so only a dead process lets a lease lapse. */
export const ROUTINE_LEASE_MS = 60_000;
/** An occurrence handled within this window of its due time is "on time";
 * anything older (or a backlog of several) is a missed-run situation. */
export const MISSED_GRACE_MS = 90_000;
/** catch-up runs at most this many missed occurrences; older ones are
 * skipped with a recorded reason. */
export const CATCH_UP_CAP = 20;
// clock-schedule occurrence counting stops here (~1 year of missed dailies)
const ENUMERATION_CAP = 400;

export interface CreateRoutineInput {
  botId: string;
  name: string;
  prompt: string;
  schedule: RoutineSchedule | unknown;
  missedPolicy?: unknown;
  thenStartTurn?: unknown;
  skillId?: string;
}

export interface RunOutcome {
  started: boolean;
  reason?: string;
}

export interface RoutinesService {
  routines(): RoutineRecord[];
  routine(id: string): RoutineRecord | null;
  createRoutine(input: CreateRoutineInput): RoutineRecord;
  patchRoutine(
    id: string,
    patch: Pick<Partial<RoutineRecord>, "name" | "prompt" | "schedule" | "enabled" | "missedPolicy" | "thenStartTurn" | "skillId">,
  ): RoutineRecord | null;
  markRoutine(id: string, patch: Pick<Partial<RoutineRecord>, "running" | "nextRunAt" | "lastRunAt" | "lastResult">): RoutineRecord | null;
  deleteRoutine(id: string): boolean;
  /** Manual "Test run": runs now, never consumes a scheduled occurrence
   * (nextRunAt is untouched), and works on a paused routine. Optional
   * `prompt` is this run only — the stored routine is not rewritten. */
  runRoutine(id: string, opts?: { prompt?: string }): Promise<RunOutcome>;
  /** Newest-first run history (capped at 20 per routine). */
  runs(id: string): RoutineRun[];
  /** Turn folding calls this on turn.completed for the routine's thread. */
  settleTurn(threadId: string, ok: boolean, stopReason?: string | null): ThenStartTurn | null;
  routineIdForThread(threadId: string): string | null;
  releaseThread(threadId: string): void;
  tick(now?: number): void;
}

/** One idempotency key per scheduled occurrence of a routine. */
export function occurrenceKey(routineId: string, scheduledFor: number): string {
  return `${routineId}@${scheduledFor}`;
}

function intervalStepMs(schedule: RoutineSchedule): number | null {
  if (schedule.kind === "interval") return schedule.everyMinutes * 60_000;
  if (schedule.kind === "listener") return (schedule.everyMinutes ?? 15) * 60_000;
  return null;
}

/** How many occurrences of `schedule` fell in [firstDue, now], and the
 * latest one. Interval schedules are computed directly; clock schedules
 * enumerate (capped — `capped` means "there were even more"). */
export function missedOccurrences(
  schedule: RoutineSchedule,
  firstDue: number,
  now: number,
): { count: number; latest: number; capped: boolean } {
  const step = intervalStepMs(schedule);
  if (step) {
    const count = Math.floor((now - firstDue) / step) + 1;
    return { count, latest: firstDue + (count - 1) * step, capped: false };
  }
  let count = 1;
  let latest = firstDue;
  while (count < ENUMERATION_CAP) {
    const next = nextRunAt(schedule, latest);
    if (next > now) return { count, latest, capped: false };
    latest = next;
    count++;
  }
  return { count, latest, capped: true };
}

function occurrenceAfterSkipping(schedule: RoutineSchedule, firstDue: number, skipCount: number): number {
  const step = intervalStepMs(schedule);
  if (step) return firstDue + skipCount * step;
  let t = firstDue;
  for (let i = 0; i < skipCount; i++) t = nextRunAt(schedule, t);
  return t;
}

export function createRoutinesService(deps: {
  repos: Repositories;
  now: () => number;
  broadcast: Broadcast;
  bot(id: string): { id: string; threadId: string; busy: boolean } | null;
  startTurn(botId: string, text: string, opts?: { extraSkillIds?: string[] }): Promise<void>;
  getSkill(id: string): SkillRecord | null;
  skillPrompt(skill: SkillRecord | null, prompt: string): string;
}): RoutinesService {
  const { repos, now, broadcast } = deps;
  const routineByThread = new Map<string, string>();
  // run rows this process owns (leases renewed every tick)
  const activeRuns = new Map<string, { seq: number; threadId: string }>();

  /** Clock schedules always carry an explicit zone from here on; a schedule
   * created without one gets the zone this process is running in. */
  function stampTimeZone(schedule: RoutineSchedule): RoutineSchedule {
    if ((schedule.kind === "daily" || schedule.kind === "weekdays") && !schedule.timeZone) {
      return { ...schedule, timeZone: localTimeZone() };
    }
    return schedule;
  }

  async function startRun(
    routine: RoutineRecord,
    at: number,
    opts: { kind: "scheduled" | "manual"; scheduledFor?: number; nextRunAt?: number; prompt?: string },
  ): Promise<RunOutcome> {
    const nextPatch = opts.nextRunAt !== undefined ? { nextRunAt: opts.nextRunAt } : {};
    const bot = deps.bot(routine.botId);
    if (!bot) {
      service.patchRoutine(routine.id, { enabled: false });
      service.markRoutine(routine.id, { running: false, lastRunAt: at, lastResult: "blocked: no such bot" });
      return { started: false, reason: "no such bot" };
    }
    if (bot.busy) {
      if (opts.kind === "scheduled") {
        repos.routines.recordSkip({
          routineId: routine.id,
          botId: routine.botId,
          at,
          scheduledFor: opts.scheduledFor,
          idempotencyKey: opts.scheduledFor !== undefined ? occurrenceKey(routine.id, opts.scheduledFor) : null,
          reason: "skipped: bot busy",
        });
        service.markRoutine(routine.id, { lastRunAt: at, lastResult: "skipped: bot busy", ...nextPatch });
      }
      return { started: false, reason: "bot busy" };
    }
    const claim = repos.routines.claimRun({
      routineId: routine.id,
      botId: routine.botId,
      startedAt: at,
      leaseUntil: at + ROUTINE_LEASE_MS,
      kind: opts.kind,
      scheduledFor: opts.scheduledFor ?? null,
      idempotencyKey: opts.kind === "scheduled" && opts.scheduledFor !== undefined ? occurrenceKey(routine.id, opts.scheduledFor) : null,
    });
    if (!claim) {
      // the occurrence already has a run row (it ran, or a live lease holds
      // it) — advance past it, never start a second run
      service.markRoutine(routine.id, { ...nextPatch });
      return { started: false, reason: "occurrence already ran" };
    }
    const runningNote =
      opts.kind === "manual" ? "running (test run)" : claim.attempt > 1 ? `running (attempt ${claim.attempt})` : "running";
    service.markRoutine(routine.id, { running: true, lastRunAt: at, lastResult: runningNote, ...nextPatch });
    activeRuns.set(routine.id, { seq: claim.seq, threadId: bot.threadId });
    routineByThread.set(bot.threadId, routine.id);
    try {
      const prompt = typeof opts.prompt === "string" && opts.prompt.trim() ? opts.prompt.trim() : routine.prompt;
      const extraSkillIds = routine.skillId ? [routine.skillId] : [];
      await deps.startTurn(routine.botId, prompt, { extraSkillIds });
    } catch (e) {
      const reason = `blocked: ${e instanceof Error ? e.message : String(e)}`;
      routineByThread.delete(bot.threadId);
      activeRuns.delete(routine.id);
      repos.routines.finishRun(claim.seq, "blocked", reason, now());
      service.markRoutine(routine.id, { running: false, lastResult: reason });
    }
    // a failed dispatch still counts as a started run: the attempt is
    // recorded in history (blocked) and surfaced over SSE
    return { started: true };
  }

  /** One due routine per tick pass: on-time occurrences just run; a backlog
   * (VelarixBot was closed or asleep) follows the routine's missed policy. */
  function schedule(routine: RoutineRecord, at: number): void {
    const firstDue = routine.nextRunAt;
    const { count, latest, capped } = missedOccurrences(routine.schedule, firstDue, at);
    if (count === 1 && at - firstDue <= MISSED_GRACE_MS) {
      void startRun(routine, at, { kind: "scheduled", scheduledFor: firstDue, nextRunAt: nextRunAt(routine.schedule, firstDue) });
      return;
    }
    const missedNote = `${count}${capped ? "+" : ""} missed run${count === 1 ? "" : "s"} while VelarixBot was closed or asleep`;
    if (routine.missedPolicy === "skip") {
      repos.routines.recordSkip({
        routineId: routine.id,
        botId: routine.botId,
        at,
        scheduledFor: latest,
        idempotencyKey: occurrenceKey(routine.id, latest),
        reason: `skipped: ${missedNote} (policy: skip)`,
      });
      service.markRoutine(routine.id, { lastResult: `skipped: ${missedNote}`, nextRunAt: nextRunAt(routine.schedule, at) });
      return;
    }
    if (routine.missedPolicy === "catch-up") {
      let target = firstDue;
      if (count > CATCH_UP_CAP) {
        const skipCount = count - CATCH_UP_CAP;
        repos.routines.recordSkip({
          routineId: routine.id,
          botId: routine.botId,
          at,
          scheduledFor: firstDue,
          idempotencyKey: occurrenceKey(routine.id, firstDue),
          reason: `skipped: ${skipCount}${capped ? "+" : ""} oldest of ${missedNote} (catch-up cap ${CATCH_UP_CAP})`,
        });
        target = occurrenceAfterSkipping(routine.schedule, firstDue, skipCount);
      }
      // next occurrence may still be in the past: the following ticks catch
      // up one run at a time, oldest first, as each run settles
      void startRun(routine, at, { kind: "scheduled", scheduledFor: target, nextRunAt: nextRunAt(routine.schedule, target) });
      return;
    }
    // run-once (default): coalesce the backlog into one run of the latest
    if (count > 1) {
      repos.routines.recordSkip({
        routineId: routine.id,
        botId: routine.botId,
        at,
        scheduledFor: firstDue,
        idempotencyKey: occurrenceKey(routine.id, firstDue),
        reason: `skipped: ${count - 1}${capped ? "+" : ""} of ${missedNote} coalesced into one run (policy: run-once)`,
      });
    }
    void startRun(routine, at, {
      kind: "scheduled",
      scheduledFor: latest,
      nextRunAt: nextRunAt(routine.schedule, capped ? at : latest),
    });
  }

  const service: RoutinesService = {
    routines: () => repos.routines.list(),
    routine: (id) => repos.routines.get(id),
    createRoutine(input) {
      if (!deps.bot(input.botId)) throw new Error("no such bot");
      if (!input.name.trim() || !input.prompt.trim()) throw new Error("name and prompt required");
      const schedule = stampTimeZone(parseRoutineSchedule(input.schedule, { strictTimeZone: true }));
      if (input.missedPolicy !== undefined && !parseMissedPolicy(input.missedPolicy)) throw new Error("invalid missed policy");
      const thenStartTurn = validThenStartTurn(input.thenStartTurn);
      const skillId = typeof input.skillId === "string" && input.skillId.trim() ? input.skillId.trim() : undefined;
      const r: RoutineRecord = {
        id: newId(),
        botId: input.botId,
        name: input.name.trim(),
        prompt: input.prompt.trim(),
        schedule,
        enabled: true,
        running: false,
        nextRunAt: nextRunAt(schedule, now()),
        lastRunAt: null,
        lastResult: null,
        createdAt: now(),
        missedPolicy: parseMissedPolicy(input.missedPolicy) ?? "run-once",
        ...(thenStartTurn ? { thenStartTurn } : {}),
        ...(skillId ? { skillId } : {}),
      };
      repos.routines.insert(r);
      return r;
    },
    patchRoutine(id, patch) {
      const r = repos.routines.get(id);
      if (!r) return null;
      const safe: Pick<Partial<RoutineRecord>, "name" | "prompt" | "schedule" | "enabled" | "missedPolicy"> = {};
      if (patch.name !== undefined) {
        if (!patch.name.trim()) throw new Error("name required");
        safe.name = patch.name.trim();
      }
      if (patch.prompt !== undefined) {
        if (!patch.prompt.trim()) throw new Error("prompt required");
        safe.prompt = patch.prompt.trim();
      }
      if (patch.schedule !== undefined) {
        safe.schedule = stampTimeZone(parseRoutineSchedule(patch.schedule, { strictTimeZone: true }));
        r.nextRunAt = nextRunAt(safe.schedule, now());
      }
      if (patch.enabled !== undefined) safe.enabled = patch.enabled === true;
      if (patch.missedPolicy !== undefined) {
        const policy = parseMissedPolicy(patch.missedPolicy);
        if (!policy) throw new Error("invalid missed policy");
        safe.missedPolicy = policy;
      }
      Object.assign(r, safe);
      if (patch.thenStartTurn !== undefined) {
        const thenStartTurn = validThenStartTurn(patch.thenStartTurn);
        if (thenStartTurn) r.thenStartTurn = thenStartTurn;
        else delete r.thenStartTurn;
      }
      if (patch.skillId !== undefined) {
        const skillId = typeof patch.skillId === "string" ? patch.skillId.trim() : "";
        if (skillId) r.skillId = skillId;
        else delete r.skillId;
      }
      repos.routines.update(r);
      return r;
    },
    markRoutine(id, patch) {
      const r = repos.routines.get(id);
      if (!r) return null;
      Object.assign(r, patch);
      repos.routines.update(r);
      broadcast({ kind: "routine", routine: r });
      return r;
    },
    deleteRoutine(id) {
      if (!repos.routines.get(id)) return false;
      repos.routines.delete(id);
      broadcast({ kind: "routine.deleted", routineId: id });
      return true;
    },
    async runRoutine(id, opts) {
      const routine = repos.routines.get(id);
      if (!routine) return { started: false, reason: "no such routine" };
      if (routine.running) return { started: false, reason: "already running" };
      const prompt = typeof opts?.prompt === "string" && opts.prompt.trim() ? opts.prompt.trim() : undefined;
      return startRun(routine, now(), { kind: "manual", ...(prompt ? { prompt } : {}) });
    },
    runs(id) {
      return repos.routines.runsFor(id);
    },
    settleTurn(threadId, ok, stopReason) {
      const routineId = routineByThread.get(threadId);
      if (!routineId) return null;
      const routine = repos.routines.get(routineId);
      const result = ok ? "DONE" : `BLOCKED: ${stopReason ?? "failed"}`;
      const active = activeRuns.get(routineId);
      if (active) repos.routines.finishRun(active.seq, ok ? "done" : "blocked", result, now());
      activeRuns.delete(routineId);
      service.markRoutine(routineId, { running: false, lastResult: result });
      routineByThread.delete(threadId);
      return routine?.thenStartTurn ?? null;
    },
    routineIdForThread: (threadId) => routineByThread.get(threadId) ?? null,
    releaseThread(threadId) {
      routineByThread.delete(threadId);
    },
    tick(at = now()) {
      // 1. keep our own runs alive
      if (activeRuns.size) {
        repos.routines.renewLeases([...activeRuns.values()].map((a) => a.seq), at + ROUTINE_LEASE_MS);
      }
      // 2. lease recovery: a running row whose lease lapsed belongs to a
      // process that died mid-run — close it and free the routine
      for (const run of repos.routines.expiredRuns(at)) {
        const reason = "interrupted: VelarixBot quit mid-run";
        repos.routines.finishRun(run.seq, "interrupted", reason, at);
        const r = repos.routines.get(run.routine_id);
        if (r?.running) service.markRoutine(run.routine_id, { running: false, lastResult: reason });
      }
      // 3. start whatever is due
      for (const routine of repos.routines.list()) {
        if (routine.enabled && !routine.running && routine.nextRunAt <= at) schedule(routine, at);
      }
    },
  };
  return service;
}
