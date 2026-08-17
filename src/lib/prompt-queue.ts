/** Client-side FIFO for composer prompts while a bot is busy. The server
 * peer-queue is for ask_bot only and 409s a second user turn — don't send
 * until the current turn is idle. Interrupt does not clear this queue. */

export interface QueuedPrompt {
  id: string;
  text: string;
  attachments: Array<{ path: string; mime?: string }>;
  mentionSkillIds?: string[];
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
): string[] {
  const ids: string[] = [];
  for (const bot of bots) {
    if (bot.busy) continue;
    if (queued[bot.id]?.[0]) ids.push(bot.id);
  }
  return ids;
}
