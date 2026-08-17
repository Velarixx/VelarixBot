// Machine lease broker (shared-box serialization, spec 3.4 / D3). One X11
// session and one Chrome live on a shared box, so at most ONE turn may act
// on a machine at a time. Turn dispatch acquires before sendTurn and
// releases when the turn settles; waiters queue FIFO and fail LOUD on
// timeout ("computer busy — in use by <botName>") — never a silent
// proceed-without-tools.
//
// Scope (D4, locked): in-memory and per-install only. It serializes bots
// within ONE VelarixBot; two co-workers pointing at the same box name are
// kept apart by cfg.box.namePrefix, not by this broker. No SQLite table.
//
// Known hazard (documented, not solved): bot A holds the lease and ask_bots
// B, who also needs the box — B queues behind A until the timeout fires.

export interface LeaseOwner {
  id: string;
  name: string;
}

/** D3 default: a queued turn waits up to 10 minutes for the machine. */
export const LEASE_WAIT_DEFAULT_MS = 10 * 60_000;

export const leaseBusyError = (holder: LeaseOwner | null): Error =>
  new Error(`computer busy — in use by ${holder?.name ?? "another bot"}`);

interface Waiter {
  owner: LeaseOwner;
  resolve(): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

interface LeaseState {
  holder: LeaseOwner;
  queue: Waiter[];
}

export interface LeaseBroker {
  /** FIFO-acquire `key` for `owner`. Resolves when the lease is held;
   * rejects with the busy error after `waitMs` (or when released while
   * still queued — an aborted turn must not acquire later). Re-acquiring a
   * key the owner already holds resolves immediately. */
  acquire(key: string, owner: LeaseOwner, opts?: { waitMs?: number }): Promise<void>;
  /** Release `key` for `ownerId` — drops a held lease (handing it to the
   * next queued waiter) or aborts the owner's queued wait. Idempotent. */
  release(key: string, ownerId: string): void;
  holder(key: string): LeaseOwner | null;
  waiting(key: string): LeaseOwner[];
  /** The OTHER owner currently holding or queued on `key`, if any — the
   * suspend guard ("in use by <botName>"). */
  busyFor(key: string, ownerId: string): LeaseOwner | null;
}

export function createLeaseBroker(): LeaseBroker {
  const leases = new Map<string, LeaseState>();

  const dropWaiter = (state: LeaseState, waiter: Waiter) => {
    const idx = state.queue.indexOf(waiter);
    if (idx !== -1) state.queue.splice(idx, 1);
    clearTimeout(waiter.timer);
  };

  return {
    acquire(key, owner, opts) {
      const state = leases.get(key);
      if (!state) {
        leases.set(key, { holder: { ...owner }, queue: [] });
        return Promise.resolve();
      }
      if (state.holder.id === owner.id) return Promise.resolve();
      const waitMs = opts?.waitMs ?? LEASE_WAIT_DEFAULT_MS;
      return new Promise<void>((resolve, reject) => {
        const waiter: Waiter = {
          owner: { ...owner },
          resolve,
          reject,
          timer: setTimeout(() => {
            dropWaiter(state, waiter);
            reject(leaseBusyError(state.holder ?? null));
          }, waitMs),
        };
        waiter.timer.unref?.();
        state.queue.push(waiter);
      });
    },

    release(key, ownerId) {
      const state = leases.get(key);
      if (!state) return;
      if (state.holder.id === ownerId) {
        const next = state.queue.shift();
        if (!next) {
          leases.delete(key);
          return;
        }
        clearTimeout(next.timer);
        state.holder = next.owner;
        next.resolve();
        return;
      }
      const queued = state.queue.find((w) => w.owner.id === ownerId);
      if (queued) {
        dropWaiter(state, queued);
        queued.reject(new Error("computer lease wait aborted — the turn ended before the machine was free"));
      }
    },

    holder(key) {
      return leases.get(key)?.holder ?? null;
    },

    waiting(key) {
      return (leases.get(key)?.queue ?? []).map((w) => w.owner);
    },

    busyFor(key, ownerId) {
      const state = leases.get(key);
      if (!state) return null;
      if (state.holder.id !== ownerId) return state.holder;
      return state.queue.find((w) => w.owner.id !== ownerId)?.owner ?? null;
    },
  };
}
