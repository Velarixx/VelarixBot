import { useEffect, useState } from "react";
import {
  AGENT_TASK_STATE_LABEL,
  archivedTasksForBot,
  isActiveQueueTask,
  taskCounts,
  type AgentTask,
} from "@/lib/agent-task";
import { taskPanelPrefForBot, writeTaskPanelPref } from "@/lib/task-panel-prefs";
import { cn } from "@/lib/cn";

const stateTone: Record<AgentTask["state"], string> = {
  pending: "bg-raised text-ink-secondary",
  active: "bg-accent/15 text-accent",
  blocked: "bg-danger/15 text-danger",
  completed: "bg-success/15 text-success",
  cancelled: "bg-raised text-ink-secondary",
  superseded: "bg-raised text-ink-secondary",
  stale: "bg-warning/15 text-warning",
};

export function TaskPanelView({
  tasks,
  botId,
  selectedTaskId,
  onSelectTask,
  visibility,
  historyOpen: historyOpenProp,
}: {
  tasks: AgentTask[];
  botId?: string;
  selectedTaskId?: string | null;
  onSelectTask?: (id: string | null) => void;
  visibility?: "open" | "collapsed" | "hidden";
  historyOpen?: boolean;
}) {
  const stored = botId ? taskPanelPrefForBot(botId) : { collapsed: false, hidden: false };
  const [collapsed, setCollapsed] = useState(visibility === "collapsed" || stored.collapsed);
  const [hidden, setHidden] = useState(visibility === "hidden" || stored.hidden);
  const [historyOpen, setHistoryOpen] = useState(historyOpenProp ?? false);

  useEffect(() => {
    if (visibility) {
      setCollapsed(visibility === "collapsed");
      setHidden(visibility === "hidden");
      return;
    }
    if (!botId) return;
    const pref = taskPanelPrefForBot(botId);
    setCollapsed(pref.collapsed);
    setHidden(pref.hidden);
  }, [botId, visibility]);

  const active = tasks.filter(isActiveQueueTask);
  const archived = botId ? archivedTasksForBot(tasks, botId) : tasks.filter((task) => !isActiveQueueTask(task));
  const { assigned, active: activeCount } = taskCounts(tasks);
  const open = tasks.find((task) => task.id === selectedTaskId) ?? null;

  if (!tasks.length) return null;

  const persist = (patch: { collapsed?: boolean; hidden?: boolean }) => {
    if (botId) writeTaskPanelPref(botId, patch);
  };

  const hidePanel = () => {
    setHidden(true);
    persist({ hidden: true });
  };

  const collapsePanel = () => {
    setCollapsed(true);
    persist({ collapsed: true });
  };

  const expandPanel = () => {
    setCollapsed(false);
    persist({ collapsed: false });
  };

  const restorePanel = () => {
    setHidden(false);
    setCollapsed(false);
    persist({ hidden: false, collapsed: false });
  };

  if (hidden) {
    const restoreLabel = activeCount > 0 ? `Assigned tasks (${activeCount})` : "Assigned tasks";
    return (
      <div className="border-t border-hairline/40 bg-panel/60 px-5 py-2" data-testid="task-panel-restore">
        <div className="mx-auto flex max-w-[900px] items-center justify-between gap-3">
          <button
            type="button"
            onClick={restorePanel}
            className="text-[13px] font-semibold text-ink hover:text-accent"
            aria-label={`Restore assigned tasks (${activeCount} active)`}
          >
            {restoreLabel}
          </button>
          {archived.length > 0 && (
            <button
              type="button"
              onClick={() => setHistoryOpen((open) => !open)}
              className="text-[12px] text-ink-secondary hover:text-ink"
              data-testid="task-panel-history-toggle"
              aria-expanded={historyOpen}
            >
              History
            </button>
          )}
        </div>
        {historyOpen && archived.length > 0 && (
          <HistoryList
            tasks={archived}
            selectedTaskId={selectedTaskId}
            onSelectTask={onSelectTask}
            open={open && !isActiveQueueTask(open) ? open : null}
          />
        )}
      </div>
    );
  }

  return (
    <section className="border-t border-hairline/40 bg-panel/60 px-5 py-3" aria-label="Assigned tasks">
      <div className="mx-auto flex max-w-[900px] flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          <div className="text-[13px] font-semibold text-ink">Assigned tasks</div>
          <div className="flex items-center gap-2">
            <div className="text-[12px] text-ink-secondary" data-testid="task-counts">
              {assigned} assigned / {activeCount} active
            </div>
            {archived.length > 0 && (
              <button
                type="button"
                onClick={() => setHistoryOpen((open) => !open)}
                className="text-[12px] text-ink-secondary hover:text-ink"
                data-testid="task-panel-history-toggle"
                aria-expanded={historyOpen}
              >
                History
              </button>
            )}
            <button
              type="button"
              onClick={collapsed ? expandPanel : collapsePanel}
              className="text-[12px] text-ink-secondary hover:text-ink"
              data-testid="task-panel-collapse"
              aria-expanded={!collapsed}
            >
              {collapsed ? "Expand" : "Collapse"}
            </button>
            <button
              type="button"
              onClick={hidePanel}
              className="text-[12px] text-ink-secondary hover:text-ink"
              data-testid="task-panel-hide"
            >
              Hide
            </button>
          </div>
        </div>
        {!collapsed && (
          <ul className="flex flex-col gap-1.5" data-testid="task-panel-active-list">
            {active.map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                selected={selectedTaskId === task.id}
                onSelectTask={onSelectTask}
                openId={open?.id}
              />
            ))}
          </ul>
        )}
        {historyOpen && archived.length > 0 && (
          <HistoryList
            tasks={archived}
            selectedTaskId={selectedTaskId}
            onSelectTask={onSelectTask}
            open={open && !isActiveQueueTask(open) ? open : null}
          />
        )}
        {!collapsed && open && isActiveQueueTask(open) && <TaskDetail task={open} />}
      </div>
    </section>
  );
}

function HistoryList({
  tasks,
  selectedTaskId,
  onSelectTask,
  open,
}: {
  tasks: AgentTask[];
  selectedTaskId?: string | null;
  onSelectTask?: (id: string | null) => void;
  open: AgentTask | null;
}) {
  return (
    <div className="mx-auto mt-2 flex w-full max-w-[900px] flex-col gap-1.5" data-testid="task-panel-history">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-secondary">History</div>
      <ul className="flex flex-col gap-1.5">
        {tasks.map((task) => (
          <TaskRow
            key={task.id}
            task={task}
            selected={selectedTaskId === task.id}
            onSelectTask={onSelectTask}
            openId={open?.id}
          />
        ))}
      </ul>
      {open && <TaskDetail task={open} />}
    </div>
  );
}

function TaskRow({
  task,
  selected,
  onSelectTask,
  openId,
}: {
  task: AgentTask;
  selected: boolean;
  onSelectTask?: (id: string | null) => void;
  openId?: string;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelectTask?.(openId === task.id ? null : task.id)}
        className={cn(
          "flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-raised/70",
          selected && "bg-raised",
        )}
      >
        <span
          className={cn(
            "rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
            stateTone[task.state],
          )}
        >
          {AGENT_TASK_STATE_LABEL[task.state]}
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{task.assignment}</span>
        <span className="shrink-0 text-[11px] text-ink-secondary">from @{task.fromName}</span>
      </button>
    </li>
  );
}

function TaskDetail({ task }: { task: AgentTask }) {
  return (
    <div className="rounded-xl border border-hairline/40 bg-card px-3 py-2.5 text-[13px] text-ink">
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-secondary">
        Original assignment
      </div>
      <div className="whitespace-pre-wrap break-words">{task.assignment}</div>
      {task.reason && <div className="mt-2 text-[12px] text-ink-secondary">Reason: {task.reason}</div>}
      {task.result && (
        <>
          <div className="mb-1 mt-3 text-[11px] font-semibold uppercase tracking-wide text-ink-secondary">
            Latest result
          </div>
          <div className="whitespace-pre-wrap break-words">{task.result}</div>
        </>
      )}
      {task.blocker && (
        <>
          <div className="mb-1 mt-3 text-[11px] font-semibold uppercase tracking-wide text-danger">
            Latest blocker
          </div>
          <div className="whitespace-pre-wrap break-words text-danger">{task.blocker}</div>
        </>
      )}
    </div>
  );
}
