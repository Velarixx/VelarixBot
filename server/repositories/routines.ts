// Routine rows + the routine_runs ledger (P1.2). Every attempt to run a
// routine — including skips — lands here as a row with an explicit status.
// Scheduled occurrences carry an idempotency key (routineId@scheduledFor):
// one logical occurrence can never produce two live runs, across ticks or
// across process restarts. A running row holds a lease the owning process
// renews every tick; a row whose lease expired belongs to a dead process
// and is recovered (interrupted, or taken over as attempt+1 by a claim).
// History keeps the newest RUN_HISTORY_KEEP rows per routine (Grok Bot
// parity).
import type { SqliteDatabase } from "../db/sqlite-native.ts";
import { normalizeRoutine, type RoutineRecord } from "../store.ts";

export const RUN_HISTORY_KEEP = 20;

interface RoutineRow {
  id: string;
  bot_id: string;
  created_at: number;
  data: string;
}

export type RoutineRunKind = "scheduled" | "manual";
export type RoutineRunStatus = "running" | "done" | "blocked" | "skipped" | "interrupted";

export interface RoutineRun {
  seq: number;
  routine_id: string;
  bot_id: string;
  started_at: number;
  finished_at: number | null;
  result: string | null;
  scheduled_for: number | null;
  kind: RoutineRunKind;
  status: RoutineRunStatus;
  attempt: number;
  idempotency_key: string | null;
  lease_until: number | null;
}

export interface ClaimRunInput {
  routineId: string;
  botId: string;
  startedAt: number;
  leaseUntil: number;
  kind: RoutineRunKind;
  scheduledFor?: number | null;
  /** Dedupes one scheduled occurrence; manual (test) runs pass none. */
  idempotencyKey?: string | null;
}

export interface RecordSkipInput {
  routineId: string;
  botId: string;
  at: number;
  reason: string;
  scheduledFor?: number | null;
  idempotencyKey?: string | null;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function assertOwnerId(ownerId: string): void {
  if (!UUID_PATTERN.test(ownerId)) throw new TypeError("ownerId must be an internal UUID");
}

function toRecord(row: RoutineRow): RoutineRecord | null {
  try {
    const parsed: unknown = JSON.parse(row.data);
    const routine = normalizeRoutine(parsed);
    if (!routine) return null;
    // normalizeRoutine resets `running` (boot semantics); live rows keep it
    const running = (parsed as { running?: unknown }).running === true;
    return { ...routine, running };
  } catch {
    return null;
  }
}

export interface RoutinesRepository {
  /** Legacy desktop access. These methods intentionally include unowned and
   * tenant-owned rows and must never be used as a tenant security boundary. */
  list(): RoutineRecord[];
  get(id: string): RoutineRecord | null;
  insert(routine: RoutineRecord): void;
  update(routine: RoutineRecord): boolean;
  delete(id: string): boolean;
  deleteForBot(botId: string): string[];
  /** Claim a run. Returns null when the occurrence already has a finished
   * row (never double-run) or a live-leased running row; an expired-lease
   * running row is taken over in place as attempt+1 (lease recovery). */
  claimRun(input: ClaimRunInput): { seq: number; attempt: number } | null;
  /** Record why an occurrence did NOT run (missed policy, busy bot).
   * Idempotent per occurrence key; returns false when already recorded. */
  recordSkip(input: RecordSkipInput): boolean;
  finishRun(seq: number, status: "done" | "blocked" | "interrupted", result: string, finishedAt: number): void;
  renewLeases(seqs: number[], leaseUntil: number): void;
  /** Running rows whose lease lapsed — the owner died mid-run. */
  expiredRuns(now: number): RoutineRun[];
  /** Boot recovery: this is a single-process app, so every running row at
   * boot is orphaned — close them as interrupted and clear the crashed
   * `running` flags on the routines themselves. Returns interrupted count. */
  recoverInterrupted(now: number): number;
  /** Newest-first history, capped at RUN_HISTORY_KEEP by pruning. */
  runsFor(routineId: string): RoutineRun[];

  /** Trusted process-wide ticking and crash recovery only. Never expose this
   * object through an HTTP/service authorization boundary. */
  readonly internalScheduler: InternalRoutineSchedulerRepository;

  /** Bind every operation to one internal user UUID. Ownership is derived
   * through routines.bot_id -> bots.owner_id; legacy owner_id=NULL rows are
   * absent. The returned interface has no global scheduler escape hatch. */
  forOwner(ownerId: string): TenantRoutinesRepository;
}

export interface InternalRoutineSchedulerRepository {
  claimRun(input: ClaimRunInput): { seq: number; attempt: number } | null;
  recordSkip(input: RecordSkipInput): boolean;
  finishRun(seq: number, status: "done" | "blocked" | "interrupted", result: string, finishedAt: number): void;
  renewLeases(seqs: number[], leaseUntil: number): void;
  expiredRuns(now: number): RoutineRun[];
  recoverInterrupted(now: number): number;
}

export interface TenantRoutinesRepository {
  list(): RoutineRecord[];
  get(id: string): RoutineRecord | null;
  insert(routine: RoutineRecord): void;
  update(routine: RoutineRecord): boolean;
  delete(id: string): boolean;
  deleteForBot(botId: string): string[];
  claimRun(input: ClaimRunInput): { seq: number; attempt: number } | null;
  recordSkip(input: RecordSkipInput): boolean;
  finishRun(seq: number, status: "done" | "blocked" | "interrupted", result: string, finishedAt: number): boolean;
  renewLeases(seqs: number[], leaseUntil: number): number;
  runsFor(routineId: string): RoutineRun[];
}

const RUN_COLUMNS =
  "seq, routine_id, bot_id, started_at, finished_at, result, scheduled_for, kind, status, attempt, idempotency_key, lease_until";

export function createRoutinesRepository(db: SqliteDatabase): RoutinesRepository {
  const insert = db.prepare("INSERT INTO routines(id, bot_id, created_at, data) VALUES (?, ?, ?, ?)");
  const update = db.prepare("UPDATE routines SET data = ? WHERE id = ?");
  const remove = db.prepare("DELETE FROM routines WHERE id = ?");
  const selectAll = db.prepare<RoutineRow>("SELECT id, bot_id, created_at, data FROM routines ORDER BY seq");
  const selectOne = db.prepare<RoutineRow>("SELECT id, bot_id, created_at, data FROM routines WHERE id = ?");
  const selectForBot = db.prepare<{ id: string }>("SELECT id FROM routines WHERE bot_id = ?");
  const selectAllForOwner = db.prepare<RoutineRow>(
    `SELECT routines.id, routines.bot_id, routines.created_at, routines.data
     FROM routines JOIN bots ON bots.id = routines.bot_id
     WHERE bots.owner_id = ? ORDER BY routines.seq`,
  );
  const selectOneForOwner = db.prepare<RoutineRow>(
    `SELECT routines.id, routines.bot_id, routines.created_at, routines.data
     FROM routines JOIN bots ON bots.id = routines.bot_id
     WHERE bots.owner_id = ? AND routines.id = ?`,
  );
  const selectForBotForOwner = db.prepare<{ id: string }>(
    `SELECT routines.id FROM routines JOIN bots ON bots.id = routines.bot_id
     WHERE bots.owner_id = ? AND routines.bot_id = ? ORDER BY routines.seq`,
  );
  const selectOwnedBot = db.prepare<{ id: string }>("SELECT id FROM bots WHERE owner_id = ? AND id = ?");
  const selectOwnedRoutineLink = db.prepare<{ id: string }>(
    `SELECT routines.id FROM routines JOIN bots ON bots.id = routines.bot_id
     WHERE bots.owner_id = ? AND routines.id = ? AND routines.bot_id = ?`,
  );
  const updateForOwner = db.prepare(
    `UPDATE routines SET data = ?
     WHERE id = ? AND bot_id = ?
       AND EXISTS (SELECT 1 FROM bots WHERE bots.id = routines.bot_id AND bots.owner_id = ?)`,
  );
  const removeForBot = db.prepare("DELETE FROM routines WHERE bot_id = ?");
  const removeRunsForBot = db.prepare("DELETE FROM routine_runs WHERE bot_id = ?");
  const removeRunsForRoutine = db.prepare("DELETE FROM routine_runs WHERE routine_id = ?");
  const insertRun = db.prepare(
    `INSERT INTO routine_runs(routine_id, bot_id, started_at, scheduled_for, kind, status, attempt, idempotency_key, lease_until)
     VALUES (?, ?, ?, ?, ?, 'running', 1, ?, ?)`,
  );
  const insertSkip = db.prepare(
    `INSERT INTO routine_runs(routine_id, bot_id, started_at, finished_at, result, scheduled_for, kind, status, attempt, idempotency_key)
     VALUES (?, ?, ?, ?, ?, ?, 'scheduled', 'skipped', 1, ?)`,
  );
  const selectByKey = db.prepare<RoutineRun>(`SELECT ${RUN_COLUMNS} FROM routine_runs WHERE idempotency_key = ?`);
  const takeoverRun = db.prepare(
    `UPDATE routine_runs SET attempt = attempt + 1, started_at = ?, lease_until = ?, finished_at = NULL, result = NULL
     WHERE seq = ? AND status = 'running'`,
  );
  const finishRunStmt = db.prepare(
    "UPDATE routine_runs SET status = ?, result = ?, finished_at = ?, lease_until = NULL WHERE seq = ? AND status = 'running'",
  );
  const renewLease = db.prepare("UPDATE routine_runs SET lease_until = ? WHERE seq = ? AND status = 'running'");
  const finishRunForOwner = db.prepare(
    `UPDATE routine_runs SET status = ?, result = ?, finished_at = ?, lease_until = NULL
     WHERE seq = ? AND status = 'running'
       AND EXISTS (
         SELECT 1 FROM routines JOIN bots ON bots.id = routines.bot_id
         WHERE routines.id = routine_runs.routine_id AND bots.owner_id = ?
       )`,
  );
  const renewLeaseForOwner = db.prepare(
    `UPDATE routine_runs SET lease_until = ?
     WHERE seq = ? AND status = 'running'
       AND EXISTS (
         SELECT 1 FROM routines JOIN bots ON bots.id = routines.bot_id
         WHERE routines.id = routine_runs.routine_id AND bots.owner_id = ?
       )`,
  );
  const selectExpired = db.prepare<RoutineRun>(
    `SELECT ${RUN_COLUMNS} FROM routine_runs WHERE status = 'running' AND (lease_until IS NULL OR lease_until <= ?)`,
  );
  const selectOpen = db.prepare<RoutineRun>(`SELECT ${RUN_COLUMNS} FROM routine_runs WHERE status = 'running'`);
  const selectRuns = db.prepare<RoutineRun>(
    `SELECT ${RUN_COLUMNS} FROM routine_runs WHERE routine_id = ? ORDER BY seq DESC LIMIT ${RUN_HISTORY_KEEP}`,
  );
  const selectRunsForOwner = db.prepare<RoutineRun>(
    `SELECT ${RUN_COLUMNS} FROM routine_runs
     WHERE routine_id = ?
       AND EXISTS (
         SELECT 1 FROM routines JOIN bots ON bots.id = routines.bot_id
         WHERE routines.id = routine_runs.routine_id AND bots.owner_id = ?
       )
     ORDER BY seq DESC LIMIT ${RUN_HISTORY_KEEP}`,
  );
  const pruneRuns = db.prepare(
    `DELETE FROM routine_runs WHERE routine_id = ? AND seq NOT IN
     (SELECT seq FROM routine_runs WHERE routine_id = ? ORDER BY seq DESC LIMIT ${RUN_HISTORY_KEEP})`,
  );

  const deleteForBotTx = db.transaction((botId: string): string[] => {
    const ids = selectForBot.all(botId).map((r) => r.id);
    removeForBot.run(botId);
    removeRunsForBot.run(botId);
    return ids;
  });
  const deleteTx = db.transaction((id: string): boolean => {
    removeRunsForRoutine.run(id);
    return remove.run(id).changes > 0;
  });

  const insertForOwnerTx = db.transaction((ownerId: string, routine: RoutineRecord): void => {
    if (!selectOwnedBot.get(ownerId, routine.botId)) throw new Error("owned bot not found");
    insert.run(routine.id, routine.botId, routine.createdAt, JSON.stringify(routine));
  });

  const deleteForOwnerTx = db.transaction((ownerId: string, id: string): boolean => {
    if (!selectOneForOwner.get(ownerId, id)) return false;
    removeRunsForRoutine.run(id);
    return remove.run(id).changes > 0;
  });

  const deleteForBotForOwnerTx = db.transaction((ownerId: string, botId: string): string[] => {
    if (!selectOwnedBot.get(ownerId, botId)) return [];
    const ids = selectForBotForOwner.all(ownerId, botId).map((row) => row.id);
    for (const id of ids) {
      removeRunsForRoutine.run(id);
      remove.run(id);
    }
    return ids;
  });

  function claimRunInternal(input: ClaimRunInput): { seq: number; attempt: number } | null {
    const key = input.idempotencyKey ?? null;
    if (key) {
      const existing = selectByKey.get(key);
      if (existing) {
        if (existing.status !== "running") return null;
        if ((existing.lease_until ?? 0) > input.startedAt) return null;
        takeoverRun.run(input.startedAt, input.leaseUntil, existing.seq);
        return { seq: existing.seq, attempt: existing.attempt + 1 };
      }
    }
    const seq = Number(
      insertRun.run(input.routineId, input.botId, input.startedAt, input.scheduledFor ?? null, input.kind, key, input.leaseUntil)
        .lastInsertRowid,
    );
    pruneRuns.run(input.routineId, input.routineId);
    return { seq, attempt: 1 };
  }

  function recordSkipInternal(input: RecordSkipInput): boolean {
    const key = input.idempotencyKey ?? null;
    if (key && selectByKey.get(key)) return false;
    insertSkip.run(input.routineId, input.botId, input.at, input.at, input.reason, input.scheduledFor ?? null, key);
    pruneRuns.run(input.routineId, input.routineId);
    return true;
  }

  function finishRunInternal(
    seq: number,
    status: "done" | "blocked" | "interrupted",
    result: string,
    finishedAt: number,
  ): void {
    finishRunStmt.run(status, result, finishedAt, seq);
  }

  function renewLeasesInternal(seqs: number[], leaseUntil: number): void {
    for (const seq of seqs) renewLease.run(leaseUntil, seq);
  }

  function recoverInterruptedInternal(now: number): number {
    const open = selectOpen.all();
    for (const run of open) {
      finishRunStmt.run("interrupted", "interrupted: VelarixBot quit mid-run", now, run.seq);
    }
    for (const row of selectAll.all()) {
      try {
        const parsed = JSON.parse(row.data) as { running?: unknown };
        if (parsed.running === true) update.run(JSON.stringify({ ...parsed, running: false }), row.id);
      } catch {
        /* unreadable rows are dropped by toRecord on read */
      }
    }
    return open.length;
  }

  const internalScheduler: InternalRoutineSchedulerRepository = {
    claimRun: claimRunInternal,
    recordSkip: recordSkipInternal,
    finishRun: finishRunInternal,
    renewLeases: renewLeasesInternal,
    expiredRuns: (now) => selectExpired.all(now),
    recoverInterrupted: recoverInterruptedInternal,
  };

  function forOwner(ownerId: string): TenantRoutinesRepository {
    assertOwnerId(ownerId);

    const claimRunForOwnerTx = db.transaction((input: ClaimRunInput) => {
      if (!selectOwnedRoutineLink.get(ownerId, input.routineId, input.botId)) return null;
      const key = input.idempotencyKey ?? null;
      if (key) {
        const existing = selectByKey.get(key);
        if (existing && (existing.routine_id !== input.routineId || existing.bot_id !== input.botId)) return null;
      }
      return claimRunInternal(input);
    });

    const recordSkipForOwnerTx = db.transaction((input: RecordSkipInput) => {
      if (!selectOwnedRoutineLink.get(ownerId, input.routineId, input.botId)) return false;
      return recordSkipInternal(input);
    });

    return {
      list() {
        return selectAllForOwner.all(ownerId).map(toRecord).filter((routine): routine is RoutineRecord => !!routine);
      },
      get(id) {
        const row = selectOneForOwner.get(ownerId, id);
        return row ? toRecord(row) : null;
      },
      insert(routine) {
        insertForOwnerTx(ownerId, routine);
      },
      update(routine) {
        return updateForOwner.run(JSON.stringify(routine), routine.id, routine.botId, ownerId).changes > 0;
      },
      delete(id) {
        return deleteForOwnerTx(ownerId, id);
      },
      deleteForBot(botId) {
        return deleteForBotForOwnerTx(ownerId, botId);
      },
      claimRun(input) {
        return claimRunForOwnerTx(input);
      },
      recordSkip(input) {
        return recordSkipForOwnerTx(input);
      },
      finishRun(seq, status, result, finishedAt) {
        return finishRunForOwner.run(status, result, finishedAt, seq, ownerId).changes > 0;
      },
      renewLeases(seqs, leaseUntil) {
        let renewed = 0;
        for (const seq of seqs) renewed += renewLeaseForOwner.run(leaseUntil, seq, ownerId).changes;
        return renewed;
      },
      runsFor(routineId) {
        return selectRunsForOwner.all(routineId, ownerId);
      },
    };
  }

  return {
    list() {
      return selectAll.all().map(toRecord).filter((r): r is RoutineRecord => !!r);
    },
    get(id) {
      const row = selectOne.get(id);
      return row ? toRecord(row) : null;
    },
    insert(routine) {
      insert.run(routine.id, routine.botId, routine.createdAt, JSON.stringify(routine));
    },
    update(routine) {
      return update.run(JSON.stringify(routine), routine.id).changes > 0;
    },
    delete(id) {
      return deleteTx(id);
    },
    deleteForBot(botId) {
      return deleteForBotTx(botId);
    },
    claimRun(input) {
      const key = input.idempotencyKey ?? null;
      if (key) {
        const existing = selectByKey.get(key);
        if (existing) {
          if (existing.status !== "running") return null; // occurrence already ran (or was skipped) — never double-run
          if ((existing.lease_until ?? 0) > input.startedAt) return null; // live lease held elsewhere
          // lease expired mid-run: recover by taking the run over in place
          takeoverRun.run(input.startedAt, input.leaseUntil, existing.seq);
          return { seq: existing.seq, attempt: existing.attempt + 1 };
        }
      }
      const seq = Number(
        insertRun.run(input.routineId, input.botId, input.startedAt, input.scheduledFor ?? null, input.kind, key, input.leaseUntil)
          .lastInsertRowid,
      );
      pruneRuns.run(input.routineId, input.routineId);
      return { seq, attempt: 1 };
    },
    recordSkip(input) {
      const key = input.idempotencyKey ?? null;
      if (key && selectByKey.get(key)) return false;
      insertSkip.run(input.routineId, input.botId, input.at, input.at, input.reason, input.scheduledFor ?? null, key);
      pruneRuns.run(input.routineId, input.routineId);
      return true;
    },
    finishRun(seq, status, result, finishedAt) {
      finishRunStmt.run(status, result, finishedAt, seq);
    },
    renewLeases(seqs, leaseUntil) {
      for (const seq of seqs) renewLease.run(leaseUntil, seq);
    },
    expiredRuns(now) {
      return selectExpired.all(now);
    },
    recoverInterrupted(now) {
      const open = selectOpen.all();
      for (const run of open) {
        finishRunStmt.run("interrupted", "interrupted: VelarixBot quit mid-run", now, run.seq);
      }
      for (const row of selectAll.all()) {
        try {
          const parsed = JSON.parse(row.data) as { running?: unknown };
          if (parsed.running === true) update.run(JSON.stringify({ ...parsed, running: false }), row.id);
        } catch {
          /* unreadable rows are dropped by toRecord on read */
        }
      }
      return open.length;
    },
    runsFor(routineId) {
      return selectRuns.all(routineId);
    },
    internalScheduler,
    forOwner,
  };
}
