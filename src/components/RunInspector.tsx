import { useEffect, useRef, useState, type Ref, type RefObject } from "react";
import type { AgentTask } from "@/lib/agent-task";
import {
  hasInspectableRun,
  projectRunInspector,
  workingLabel,
  type RunInspectorFields,
  type RunInspectorInput,
} from "@/lib/run-inspector";
import type { Bot } from "@/state/store";

export function inspectorInputFromBot(
  bot: Bot,
  tasks: AgentTask[],
  since: number,
  now: number,
): RunInspectorInput {
  return {
    botId: bot.id,
    busy: bot.busy === true,
    state: bot.state ?? "IDLE",
    stateDetail: bot.stateDetail,
    workflowStatus: bot.workflowStatus,
    workflowWaitingFor: bot.workflowWaitingFor,
    workflowStopReason: bot.workflowStopReason,
    messages: bot.messages,
    tasks,
    now,
    since,
  };
}

function Field({ label, value, testId }: { label: string; value?: string; testId: string }) {
  if (!value) return null;
  return (
    <div data-testid={testId}>
      <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-secondary">{label}</div>
      <div className="mt-0.5 min-w-0 break-words font-mono text-[13px] text-ink">{value}</div>
    </div>
  );
}

/** Tick elapsed by mutating textContent — no React commit per second. */
function useElapsedTick(
  since: number,
  active: boolean,
  pillRef: RefObject<HTMLSpanElement | null>,
  elapsedRef: RefObject<HTMLSpanElement | null>,
) {
  useEffect(() => {
    if (!active) return;
    const tick = () => {
      const seconds = Math.max(0, Math.round((Date.now() - since) / 1000));
      if (pillRef.current) pillRef.current.textContent = workingLabel(seconds);
      if (elapsedRef.current) elapsedRef.current.textContent = `${seconds}s`;
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [active, since, pillRef, elapsedRef]);
}

export function RunInspectorView({
  fields,
  open,
  onToggle,
  onClose,
  pillRef,
  elapsedRef,
}: {
  fields: RunInspectorFields;
  open: boolean;
  onToggle?: () => void;
  onClose?: () => void;
  pillRef?: Ref<HTMLSpanElement>;
  elapsedRef?: Ref<HTMLSpanElement>;
}) {
  return (
    <div className="relative flex justify-start" data-testid="run-inspector">
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls="run-inspector-panel"
        onClick={onToggle}
        className="flex items-center gap-2.5 rounded-2xl bg-raised px-4 py-3 text-left text-[12.5px] text-ink-secondary hover:bg-raised-hover"
      >
        {fields.active && (
          <span className="flex items-center gap-1.5" aria-hidden="true">
            <span className="size-1.5 animate-bounce rounded-full bg-ink-secondary [animation-delay:0ms]" />
            <span className="size-1.5 animate-bounce rounded-full bg-ink-secondary [animation-delay:150ms]" />
            <span className="size-1.5 animate-bounce rounded-full bg-ink-secondary [animation-delay:300ms]" />
          </span>
        )}
        <span ref={pillRef} data-testid="run-inspector-pill">
          {fields.pillLabel}
        </span>
      </button>
      {open && (
        <div
          id="run-inspector-panel"
          role="dialog"
          aria-label="Run details"
          data-testid="run-inspector-panel"
          className="absolute left-0 top-full z-20 mt-2 w-[min(360px,calc(100vw-2.5rem))] rounded-xl border border-hairline/50 bg-card p-3 shadow-2xl shadow-black/50"
        >
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="text-[13px] font-semibold text-ink">Run details</div>
            <button
              type="button"
              onClick={onClose}
              className="rounded-md px-1.5 py-0.5 text-[12px] text-ink-secondary hover:bg-raised hover:text-ink"
              aria-label="Close"
            >
              Close
            </button>
          </div>
          <div className="flex flex-col gap-2.5">
            <Field label="Status" value={fields.status} testId="run-inspector-status" />
            <Field label="Activity" value={fields.activity} testId="run-inspector-activity" />
            <div data-testid="run-inspector-elapsed">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-secondary">Elapsed</div>
              <span ref={elapsedRef} className="mt-0.5 block text-[13px] text-ink">
                {fields.elapsedSeconds}s
              </span>
            </div>
            <Field label="Delegated" value={fields.delegated} testId="run-inspector-delegated" />
            <Field label="Waiting" value={fields.blocked} testId="run-inspector-blocked" />
            <Field label="Outcome" value={fields.outcome} testId="run-inspector-outcome" />
          </div>
        </div>
      )}
    </div>
  );
}

export function RunInspector({
  bot,
  tasks,
  since,
  now,
}: {
  bot: Bot;
  tasks: AgentTask[];
  since: number;
  now?: number;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLSpanElement>(null);
  const elapsedRef = useRef<HTMLSpanElement>(null);
  const clock = now ?? Date.now();
  const fields = projectRunInspector(inspectorInputFromBot(bot, tasks, since, clock));

  useElapsedTick(since, fields.active, pillRef, elapsedRef);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!hasInspectableRun(bot)) return null;

  return (
    <div ref={rootRef}>
      <RunInspectorView
        fields={fields}
        open={open}
        onToggle={() => setOpen((value) => !value)}
        onClose={() => setOpen(false)}
        pillRef={pillRef}
        elapsedRef={elapsedRef}
      />
    </div>
  );
}
