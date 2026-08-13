// Stall nudges + first event triggers. Runs only while the harness is up
// (the caller ticks; there is no cloud cron). Fake-clock friendly: pass
// `now` and call `tick()` — no sleeps.
import type { BotState } from "./store.ts";

export const DEFAULT_STALL_MS = 2 * 60 * 60 * 1000;

export type StallState = "NEEDS_INPUT" | "BLOCKED";

function isStall(state: string): state is StallState {
  return state === "NEEDS_INPUT" || state === "BLOCKED";
}

export interface ThenStartTurn {
  botId: string;
  prompt: string;
}

export function createProactive(opts: {
  now: () => number;
  stallMs?: number;
  onNudge: (botId: string) => void;
  onTrigger: (botId: string, prompt: string) => void;
}) {
  const stallMs = opts.stallMs ?? DEFAULT_STALL_MS;
  const stalls = new Map<string, { enteredAt: number; nudged: boolean }>();

  return {
    noteState(botId: string, state: BotState | string) {
      if (isStall(state)) {
        if (!stalls.has(botId)) stalls.set(botId, { enteredAt: opts.now(), nudged: false });
        return;
      }
      stalls.delete(botId);
    },
    /** Answer / new turn / dismiss — the stall clock starts over. */
    reset(botId: string) {
      stalls.delete(botId);
    },
    tick(now = opts.now()) {
      for (const [botId, stall] of stalls) {
        if (stall.nudged) continue;
        if (now - stall.enteredAt < stallMs) continue;
        stall.nudged = true;
        opts.onNudge(botId);
      }
    },
    routineCompleted(then?: ThenStartTurn | null) {
      const botId = then?.botId?.trim();
      const prompt = then?.prompt?.trim();
      if (!botId || !prompt) return;
      opts.onTrigger(botId, prompt);
    },
  };
}

export type Proactive = ReturnType<typeof createProactive>;
