/** Client-side FIFO for composer prompts while a bot is busy. The server
 * peer-queue is for ask_bot only and 409s a second user turn — don't send
 * until the current turn is idle. Interrupt does not clear this queue. */

export interface QueuedPrompt {
  id: string;
  text: string;
  attachments: Array<{ path: string; mime?: string }>;
}

export function sendDecision(busy: boolean): "send" | "queue" {
  return busy ? "queue" : "send";
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

/** Interrupt/stop ends the current turn; queued follow-ups stay in order. */
export function queueAfterInterrupt(queue: QueuedPrompt[]): QueuedPrompt[] {
  return queue;
}
