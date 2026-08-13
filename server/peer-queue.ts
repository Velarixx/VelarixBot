// FIFO per-bot queue for ask_bot when the peer is busy. Waiters resolve
// on an idle signal (turn.completed / error) — no sleeps, no polling.

export interface PeerQueue {
  enqueue<T>(botId: string, work: () => Promise<T>): Promise<T>;
}

export function createPeerQueue(opts: {
  isBusy: (botId: string) => boolean;
  /** Subscribe to idle notifications; return unsubscribe. */
  onIdle: (listener: (botId: string) => void) => () => void;
  now?: () => number;
  budgetMs?: number;
}): PeerQueue {
  const tails = new Map<string, Promise<unknown>>();
  const now = () => (opts.now ? opts.now() : Date.now());
  const budgetMs = opts.budgetMs ?? 4 * 60_000;

  function waitIdle(botId: string, deadline: number): Promise<void> {
    if (!opts.isBusy(botId)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        unsub();
        clearTimeout(timer);
        fn();
      };
      const unsub = opts.onIdle((id) => {
        if (id !== botId) return;
        if (!opts.isBusy(botId)) finish(() => resolve());
      });
      const timer = setTimeout(
        () => finish(() => reject(new Error("timed out waiting for a busy peer"))),
        Math.max(0, deadline - now()),
      );
      timer.unref?.();
    });
  }

  function enqueue<T>(botId: string, work: () => Promise<T>): Promise<T> {
    const deadline = now() + budgetMs;
    const prev = tails.get(botId) ?? Promise.resolve();
    const run = () => waitIdle(botId, deadline).then(work);
    const next = prev.then(run, run);
    tails.set(
      botId,
      next.then(
        () => {},
        () => {},
      ),
    );
    return next;
  }

  return { enqueue };
}
