import { Check, CircleAlert, Flag, Loader2 } from "lucide-react";
import type { Message } from "@/state/store";
import { cn } from "@/lib/cn";
import { ChatMarkdown } from "./ChatMarkdown";

const REPORT_LABEL: Record<NonNullable<Message["report"]>["kind"], string> = {
  progress: "Progress",
  blocker: "Blocked",
  completion: "Completed",
  handoff: "Handoff",
};

function ReportIcon({ kind }: { kind: NonNullable<Message["report"]>["kind"] }) {
  if (kind === "progress") return <Loader2 size={13} className="animate-spin" />;
  if (kind === "blocker") return <CircleAlert size={13} />;
  if (kind === "handoff") return <Flag size={13} />;
  return <Check size={13} className="text-success" />;
}

export function AgentReportView({
  message,
  onOpenAgent,
  onOpenTask,
}: {
  message: Message;
  onOpenAgent?: (botId: string) => void;
  onOpenTask?: (taskId: string) => void;
}) {
  const report = message.report;
  if (!report) return null;
  const name = message.from?.name;
  const label = REPORT_LABEL[report.kind];
  const blocked = report.kind === "blocker";
  const body = message.text ?? message.tool?.name ?? "";

  return (
    <div className="flex w-full min-w-0 justify-start">
      <div
        className={cn(
          "min-w-0 max-w-[80%] overflow-hidden rounded-2xl border px-3 py-2 text-[13px]",
          blocked ? "border-danger/30 bg-danger/10 text-danger" : "border-hairline/40 bg-panel text-ink",
        )}
      >
        <div className="mb-1 flex min-w-0 items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-ink-secondary">
          <span aria-label={label} title={label}>
            <ReportIcon kind={report.kind} />
          </span>
          <span>{label}</span>
          {name && (
            <button
              type="button"
              onClick={() => onOpenAgent?.(report.fromBotId)}
              className="truncate font-semibold normal-case tracking-normal text-ink hover:underline"
            >
              {name}
            </button>
          )}
        </div>
        {body &&
          (message.kind === "text" ? (
            <div className="min-w-0 text-[14px] leading-relaxed text-ink">
              <ChatMarkdown text={body} />
            </div>
          ) : (
            <div className="min-w-0 truncate font-mono text-[13px] text-ink-secondary">{body}</div>
          ))}
        {report.taskId && onOpenTask && (
          <button
            type="button"
            onClick={() => onOpenTask(report.taskId!)}
            className="mt-1.5 text-[12px] text-ink-secondary hover:text-ink"
          >
            Open task details
          </button>
        )}
      </div>
    </div>
  );
}
