/** Client-side FIFO retains composer prompts until the server acknowledges
 * delivery. Follow-ups wait for idle; Stop pauses without deleting them. */

export interface QueuedPrompt {
  id: string;
  text: string;
  attachments: Array<{ path: string; mime?: string }>;
  mentionSkillIds?: string[];
  status?: "sending" | "failed";
  error?: string;
}

/** Wrapper: a send while the bot is busy (or a POST is already in flight)
 * becomes enqueue, not startTurn. */
export function shouldEnqueueSend(busy: boolean, posting = false): boolean {
  return busy || posting;
}

export function enqueuePrompt(queue: QueuedPrompt[], item: QueuedPrompt): QueuedPrompt[] {
  return [...queue, item];
}

export function cancelPrompt(queue: QueuedPrompt[], id: string): QueuedPrompt[] {
  return queue.filter((item) => item.id !== id);
}

export function takeNext(queue: QueuedPrompt[]): { next: QueuedPrompt | null; rest: QueuedPrompt[] } {
  if (queue.length === 0) return { next: null, rest: queue };
  const [next, ...rest] = queue;
  return { next, rest };
}

/** Same walk as the store useEffect: idle bots with a queued head. */
export function nextFlushBotIds(
  bots: Array<{ id: string; busy?: boolean }>,
  queued: Record<string, QueuedPrompt[] | undefined>,
  paused: Record<string, boolean> = {},
): string[] {
  const ids: string[] = [];
  for (const bot of bots) {
    if (bot.busy || paused[bot.id]) continue;
    const head = queued[bot.id]?.[0];
    if (head && !head.status) ids.push(bot.id);
  }
  return ids;
}

const QUEUE_KEY = "velarixbot:pending-prompts:v1";
export function restorePromptQueue(): { queued: Record<string, QueuedPrompt[]>; queuePaused: Record<string, boolean> } {
  const queued: Record<string, QueuedPrompt[]> = {};
  const queuePaused: Record<string, boolean> = {};
  try {
    const saved = JSON.parse(sessionStorage.getItem(QUEUE_KEY) ?? "{}");
    for (const [botId, items] of Object.entries(saved)) {
      if (!Array.isArray(items) || !items.length) continue;
      queued[botId] = items.filter((item) => item && typeof item.id === "string" && typeof item.text === "string" && Array.isArray(item.attachments))
        .map((item) => item.status === "sending" ? { ...item, status: "failed", error: "Delivery was interrupted. Retry safely with the same message ID." } : item);
      // A renderer reload must never silently resume queued work.
      queuePaused[botId] = true;
    }
  } catch { /* Start without restored work when storage is unavailable. */ }
  return { queued, queuePaused };
}

export function persistPromptQueue(queued: Record<string, QueuedPrompt[]>): void {
  try { sessionStorage.setItem(QUEUE_KEY, JSON.stringify(queued)); } catch { /* In-memory queue remains available. */ }
}
