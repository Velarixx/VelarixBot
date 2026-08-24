// Assigned-task rows for lead→agent delegation (#120). JSON in `data`
// so we can add fields without another migration; indexed columns are
// the query keys (assignee, source thread).
import type { SqliteDatabase } from "../db/sqlite-native.ts";
import { normalizeAgentTask, type AgentTask, type AgentTasksStore } from "../agent-tasks.ts";

interface TaskRow {
  id: string;
  assignee_bot_id: string;
  from_bot_id: string;
  source_thread_id: string;
  created_at: number;
  updated_at: number;
  data: string;
}

function toTask(row: TaskRow): AgentTask | null {
  try {
    return normalizeAgentTask(JSON.parse(row.data));
  } catch {
    return null;
  }
}

export function createAgentTasksRepository(db: SqliteDatabase): AgentTasksStore {
  const insert = db.prepare(
    "INSERT INTO agent_tasks(id, assignee_bot_id, from_bot_id, source_thread_id, created_at, updated_at, data) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const selectOne = db.prepare<TaskRow>(
    "SELECT id, assignee_bot_id, from_bot_id, source_thread_id, created_at, updated_at, data FROM agent_tasks WHERE id = ?",
  );
  const selectAll = db.prepare<TaskRow>(
    "SELECT id, assignee_bot_id, from_bot_id, source_thread_id, created_at, updated_at, data FROM agent_tasks ORDER BY created_at, id",
  );
  const selectAssignee = db.prepare<TaskRow>(
    "SELECT id, assignee_bot_id, from_bot_id, source_thread_id, created_at, updated_at, data FROM agent_tasks WHERE assignee_bot_id = ? ORDER BY created_at, id",
  );
  const selectSource = db.prepare<TaskRow>(
    "SELECT id, assignee_bot_id, from_bot_id, source_thread_id, created_at, updated_at, data FROM agent_tasks WHERE source_thread_id = ? ORDER BY created_at, id",
  );
  const updateSql = db.prepare(
    "UPDATE agent_tasks SET assignee_bot_id = ?, from_bot_id = ?, source_thread_id = ?, updated_at = ?, data = ? WHERE id = ?",
  );
  const deleteBot = db.prepare("DELETE FROM agent_tasks WHERE assignee_bot_id = ? OR from_bot_id = ?");

  return {
    insert(task) {
      insert.run(
        task.id,
        task.assigneeBotId,
        task.fromBotId,
        task.sourceThreadId,
        task.createdAt,
        task.updatedAt,
        JSON.stringify(task),
      );
      return task;
    },
    get(id) {
      const row = selectOne.get(id);
      return row ? toTask(row) : null;
    },
    list() {
      return selectAll.all().map(toTask).filter((task): task is AgentTask => Boolean(task));
    },
    listByAssignee(botId) {
      return selectAssignee.all(botId).map(toTask).filter((task): task is AgentTask => Boolean(task));
    },
    listBySourceThread(threadId) {
      return selectSource.all(threadId).map(toTask).filter((task): task is AgentTask => Boolean(task));
    },
    update(id, patch) {
      const existing = this.get(id);
      if (!existing) return null;
      const next = normalizeAgentTask({ ...existing, ...patch, id, createdAt: existing.createdAt });
      if (!next) return null;
      updateSql.run(next.assigneeBotId, next.fromBotId, next.sourceThreadId, next.updatedAt, JSON.stringify(next), id);
      return next;
    },
    deleteForBot(botId) {
      return deleteBot.run(botId, botId).changes;
    },
  };
}
