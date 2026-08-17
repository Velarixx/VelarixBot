// Bot-keyed unattended mark. A GitHub/Slack listener turn starts with
// nobody at the keyboard, so standing Always-allow rules and the per-bot
// alwaysAllow flag must not auto-resolve. The mark is the only signal
// autoResolvePermission consults for that; persist / P0.1 matchers stay
// untouched.
//
// Keyed by BOT (one turn at a time) rather than thread: peer hops know
// who is asking, not always from which thread. Idle marks expire (TTL)
// instead of clearing on turn.completed — bus subscribers fire in
// registration order, and a hop that runs after the fold would otherwise
// read a blank flag. A busy bot never ages out. A stale mark only ever
// means "ask a human", so this fails closed.
//
// Clock-injectable: tests pass `now` / `at`. No sleeps.

export const UNATTENDED_TTL_MS = 30 * 60_000;

const marks = new Map<string, number>();
let nowFn = () => Date.now();
let busyFn: (botId: string) => boolean = () => false;

export function configureUnattended(opts: { now?: () => number; isBusy?: (botId: string) => boolean }): void {
  if (opts.now) nowFn = opts.now;
  if (opts.isBusy) busyFn = opts.isBusy;
}

export function markUnattended(botId: string, at?: number): void {
  const id = botId.trim();
  if (!id) return;
  marks.set(id, at ?? nowFn());
}

export function clearUnattended(botId: string): void {
  marks.delete(botId);
}

/** True when this bot is still inside an unattended window. A positive
 * read refreshes the inactivity TTL so a long-running turn does not age
 * out between permission asks. Only an idle bot may expire. */
export function isUnattended(botId?: string | null, at?: number): boolean {
  if (!botId) return false;
  const marked = marks.get(botId);
  if (marked === undefined) return false;
  const now = at ?? nowFn();
  if (now - marked > UNATTENDED_TTL_MS && !busyFn(botId)) {
    marks.delete(botId);
    return false;
  }
  marks.set(botId, now);
  return true;
}

/** Snapshot for a peer hop. Capture at enqueue / ask time so a TTL
 * expiry while the peer-queue waits cannot drop the gate. */
export function hopUnattended(opts?: { fromBotId?: string; unattended?: boolean }): boolean {
  return opts?.unattended === true || isUnattended(opts?.fromBotId);
}

/** Test-only: drop every mark and restore the default clock. */
export function resetUnattended(): void {
  marks.clear();
  nowFn = () => Date.now();
  busyFn = () => false;
}
