import { AGENT_TASK_STATE_LABEL, taskCounts, type AgentTask } from "@/lib/agent-task";
import { cn } from "@/lib/cn";

const stateTone: Record<AgentTask["state"], string> = {
  pending: "bg-raised text-ink-secondary",
  active: "bg-accent/15 text-accent",
  blocked: "bg-danger/15 text-danger",
  completed: "bg-success/15 text-success",
};

export function TaskPanelView({
  tasks,
  selectedTaskId,
  onSelectTask,
}: {
  tasks: AgentTask[];
  selectedTaskId?: string | null;
  onSelectTask?: (id: string | null) => void;
}) {
  if (!tasks.length) return null;
  const { completed, total } = taskCounts(tasks);
  const open = tasks.find((task) => task.id === selectedTaskId) ?? null;

  return (
    <section className="border-t border-hairline/40 bg-panel/60 px-5 py-3" aria-label="Assigned tasks">
      <div className="mx-auto flex max-w-[900px] flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          <div className="text-[13px] font-semibold text-ink">Assigned tasks</div>
          <div className="text-[12px] text-ink-secondary" data-testid="task-counts">
            {completed}/{total} completed
          </div>
        </div>
        <ul className="flex flex-col gap-1.5">
          {tasks.map((task) => (
            <li key={task.id}>
              <button
                type="button"
                onClick={() => onSelectTask?.(open?.id === task.id ? null : task.id)}
                className={cn(
                  "flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-raised/70",
                  selectedTaskId === task.id && "bg-raised",
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
          ))}
        </ul>
        {open && (
          <div className="rounded-xl border border-hairline/40 bg-card px-3 py-2.5 text-[13px] text-ink">
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-secondary">
              Original assignment
            </div>
            <div className="whitespace-pre-wrap break-words">{open.assignment}</div>
            {open.reason && (
              <div className="mt-2 text-[12px] text-ink-secondary">Reason: {open.reason}</div>
            )}
            {open.result && (
              <>
                <div className="mb-1 mt-3 text-[11px] font-semibold uppercase tracking-wide text-ink-secondary">
                  Latest result
                </div>
                <div className="whitespace-pre-wrap break-words">{open.result}</div>
              </>
            )}
            {open.blocker && (
              <>
                <div className="mb-1 mt-3 text-[11px] font-semibold uppercase tracking-wide text-danger">
                  Latest blocker
                </div>
                <div className="whitespace-pre-wrap break-words text-danger">{open.blocker}</div>
              </>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
