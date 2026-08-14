// Routine domain + scheduler. Fake-clock friendly like proactive.ts: the
// service takes `now` and the caller ticks — no timers, no sleeps in here.
// Every started run lands in routine_runs and is finished in place when the
// turn settles.
import type { Repositories } from "../repositories/index.ts";
import type { SkillRecord } from "../teach.ts";
import {
  nextRunAt,
  parseRoutineSchedule,
  validThenStartTurn,
  type RoutineRecord,
  type RoutineSchedule,
  type ThenStartTurn,
} from "../store.ts";
import { newId } from "../contracts.ts";
import type { Broadcast } from "./events.ts";

export interface CreateRoutineInput {
  botId: string;
  name: string;
  prompt: string;
  schedule: RoutineSchedule | unknown;
  thenStartTurn?: unknown;
  skillId?: string;
}

export interface RoutinesService {
  routines(): RoutineRecord[];
  routine(id: string): RoutineRecord | null;
  createRoutine(input: CreateRoutineInput): RoutineRecord;
  patchRoutine(
    id: string,
    patch: Pick<Partial<RoutineRecord>, "name" | "prompt" | "schedule" | "enabled" | "thenStartTurn" | "skillId">,
  ): RoutineRecord | null;
  markRoutine(id: string, patch: Pick<Partial<RoutineRecord>, "running" | "nextRunAt" | "lastRunAt" | "lastResult">): RoutineRecord | null;
  deleteRoutine(id: string): boolean;
  runRoutine(id: string): Promise<void>;
  /** Turn folding calls this on turn.completed for the routine's thread. */
  settleTurn(threadId: string, ok: boolean, stopReason?: string | null): ThenStartTurn | null;
  routineIdForThread(threadId: string): string | null;
  releaseThread(threadId: string): void;
  tick(now?: number): void;
}

export function createRoutinesService(deps: {
  repos: Repositories;
  now: () => number;
  broadcast: Broadcast;
  bot(id: string): { id: string; threadId: string; busy: boolean } | null;
  startTurn(botId: string, text: string): Promise<void>;
  getSkill(id: string): SkillRecord | null;
  skillPrompt(skill: SkillRecord | null, prompt: string): string;
}): RoutinesService {
  const { repos, now, broadcast } = deps;
  const routineByThread = new Map<string, string>();

  const service: RoutinesService = {
    routines: () => repos.routines.list(),
    routine: (id) => repos.routines.get(id),
    createRoutine(input) {
      if (!deps.bot(input.botId)) throw new Error("no such bot");
      if (!input.name.trim() || !input.prompt.trim()) throw new Error("name and prompt required");
      const schedule = parseRoutineSchedule(input.schedule);
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
        ...(thenStartTurn ? { thenStartTurn } : {}),
        ...(skillId ? { skillId } : {}),
      };
      repos.routines.insert(r);
      return r;
    },
    patchRoutine(id, patch) {
      const r = repos.routines.get(id);
      if (!r) return null;
      const safe: Pick<Partial<RoutineRecord>, "name" | "prompt" | "schedule" | "enabled"> = {};
      if (patch.name !== undefined) {
        if (!patch.name.trim()) throw new Error("name required");
        safe.name = patch.name.trim();
      }
      if (patch.prompt !== undefined) {
        if (!patch.prompt.trim()) throw new Error("prompt required");
        safe.prompt = patch.prompt.trim();
      }
      if (patch.schedule !== undefined) {
        safe.schedule = parseRoutineSchedule(patch.schedule);
        r.nextRunAt = nextRunAt(safe.schedule, now());
      }
      if (patch.enabled !== undefined) safe.enabled = patch.enabled === true;
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
      // routine_runs bookkeeping rides the running flag transitions
      if (patch.running === true && !r.running) repos.routines.startRun(r, patch.lastRunAt ?? now());
      if (patch.running === false && r.running) repos.routines.finishRun(r.id, patch.lastResult ?? r.lastResult ?? "", now());
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
    async runRoutine(id) {
      const routine = repos.routines.get(id);
      if (!routine || !routine.enabled || routine.running) return;
      const bot = deps.bot(routine.botId);
      if (!bot) {
        service.patchRoutine(id, { enabled: false });
        service.markRoutine(id, { running: false, lastRunAt: now(), lastResult: "blocked: no such bot" });
        return;
      }
      if (bot.busy) {
        service.markRoutine(id, { lastRunAt: now(), lastResult: "skipped: bot busy", nextRunAt: nextRunAt(routine.schedule, now()) });
        return;
      }
      service.markRoutine(id, { running: true, lastRunAt: now(), lastResult: "running", nextRunAt: nextRunAt(routine.schedule, now()) });
      routineByThread.set(bot.threadId, id);
      try {
        const skill = routine.skillId ? deps.getSkill(routine.skillId) : null;
        await deps.startTurn(routine.botId, deps.skillPrompt(skill, routine.prompt));
      } catch (e) {
        routineByThread.delete(bot.threadId);
        service.markRoutine(id, { running: false, lastResult: `blocked: ${e instanceof Error ? e.message : String(e)}` });
      }
    },
    settleTurn(threadId, ok, stopReason) {
      const routineId = routineByThread.get(threadId);
      if (!routineId) return null;
      const routine = repos.routines.get(routineId);
      service.markRoutine(routineId, { running: false, lastResult: ok ? "DONE" : `BLOCKED: ${stopReason ?? "failed"}` });
      routineByThread.delete(threadId);
      return routine?.thenStartTurn ?? null;
    },
    routineIdForThread: (threadId) => routineByThread.get(threadId) ?? null,
    releaseThread(threadId) {
      routineByThread.delete(threadId);
    },
    tick(at = now()) {
      for (const routine of repos.routines.list()) {
        if (routine.enabled && !routine.running && routine.nextRunAt <= at) void service.runRoutine(routine.id);
      }
    },
  };
  return service;
}
