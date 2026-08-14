// Routine rows + the routine_runs history: one row per started run,
// finished in place when the routine settles.
import type { SqliteDatabase } from "../db/sqlite-native.ts";
import { normalizeRoutine, type RoutineRecord } from "../store.ts";

interface RoutineRow {
  id: string;
  bot_id: string;
  created_at: number;
  data: string;
}

export interface RoutineRun {
  seq: number;
  routine_id: string;
  bot_id: string;
  started_at: number;
  finished_at: number | null;
  result: string | null;
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
  list(): RoutineRecord[];
  get(id: string): RoutineRecord | null;
  insert(routine: RoutineRecord): void;
  update(routine: RoutineRecord): boolean;
  delete(id: string): boolean;
  deleteForBot(botId: string): string[];
  startRun(routine: { id: string; botId: string }, startedAt: number): number;
  finishRun(routineId: string, result: string, finishedAt: number): void;
  runsFor(routineId: string): RoutineRun[];
}

export function createRoutinesRepository(db: SqliteDatabase): RoutinesRepository {
  const insert = db.prepare("INSERT INTO routines(id, bot_id, created_at, data) VALUES (?, ?, ?, ?)");
  const update = db.prepare("UPDATE routines SET data = ? WHERE id = ?");
  const remove = db.prepare("DELETE FROM routines WHERE id = ?");
  const selectAll = db.prepare<RoutineRow>("SELECT id, bot_id, created_at, data FROM routines ORDER BY seq");
  const selectOne = db.prepare<RoutineRow>("SELECT id, bot_id, created_at, data FROM routines WHERE id = ?");
  const selectForBot = db.prepare<{ id: string }>("SELECT id FROM routines WHERE bot_id = ?");
  const removeForBot = db.prepare("DELETE FROM routines WHERE bot_id = ?");
  const removeRunsForBot = db.prepare("DELETE FROM routine_runs WHERE bot_id = ?");
  const insertRun = db.prepare("INSERT INTO routine_runs(routine_id, bot_id, started_at) VALUES (?, ?, ?)");
  const finishRunStmt = db.prepare(
    `UPDATE routine_runs SET finished_at = ?, result = ?
     WHERE seq = (SELECT max(seq) FROM routine_runs WHERE routine_id = ? AND finished_at IS NULL)`,
  );
  const selectRuns = db.prepare<RoutineRun>(
    "SELECT seq, routine_id, bot_id, started_at, finished_at, result FROM routine_runs WHERE routine_id = ? ORDER BY seq",
  );

  const deleteForBotTx = db.transaction((botId: string): string[] => {
    const ids = selectForBot.all(botId).map((r) => r.id);
    removeForBot.run(botId);
    removeRunsForBot.run(botId);
    return ids;
  });

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
      return remove.run(id).changes > 0;
    },
    deleteForBot(botId) {
      return deleteForBotTx(botId);
    },
    startRun(routine, startedAt) {
      return Number(insertRun.run(routine.id, routine.botId, startedAt).lastInsertRowid);
    },
    finishRun(routineId, result, finishedAt) {
      finishRunStmt.run(finishedAt, result, routineId);
    },
    runsFor(routineId) {
      return selectRuns.all(routineId);
    },
  };
}
