import { useState } from "react";
import { Ban, Check, ChevronDown, ChevronUp, Clock, Copy, Loader2, X } from "lucide-react";
import type { Message } from "@/state/store";
import { cn } from "@/lib/cn";
import {
  ACTIVITY_STATUS_LABEL,
  activityStatusOf,
  commandLabel,
  commandNeedsExpand,
  visibleCommand,
} from "@/lib/chat-message";

function StatusIcon({ status }: { status: ReturnType<typeof activityStatusOf> }) {
  if (status === "running") return <Loader2 size={13} className="animate-spin" />;
  if (status === "failed") return <X size={13} />;
  if (status === "cancelled") return <Ban size={13} />;
  if (status === "timed_out") return <Clock size={13} />;
  return <Check size={13} className="text-success" />;
}

export function ActivityChipView({
  message,
  expanded,
  copied,
  onToggle,
  onCopy,
  onOpenGroup,
}: {
  message: Message;
  expanded: boolean;
  copied?: boolean;
  onToggle?: () => void;
  onCopy?: () => void;
  onOpenGroup?: (groupId: string) => void;
}) {
  const tool = message.tool;
  if (!tool) return null;
  const status = activityStatusOf(tool);
  const failed = status === "failed" || status === "cancelled" || status === "timed_out";
  const groupId = message.comm?.groupId;
  const command = visibleCommand(tool);
  const label = commandLabel(tool);
  const expandable = commandNeedsExpand(tool);

  return (
    <div className="flex justify-start">
      <div
        className={cn(
          "min-w-0 max-w-full rounded-2xl border border-hairline/40 bg-panel px-3 py-1.5 text-[13px]",
          failed ? "text-danger" : "text-ink-secondary",
        )}
      >
        <div className="flex min-w-0 items-center gap-2">
          <span title={ACTIVITY_STATUS_LABEL[status]} aria-label={ACTIVITY_STATUS_LABEL[status]}>
            <StatusIcon status={status} />
          </span>
          {groupId && onOpenGroup ? (
            <button
              type="button"
              onClick={() => onOpenGroup(groupId)}
              className="min-w-0 truncate font-mono hover:text-ink"
              title={label}
            >
              {label}
            </button>
          ) : (
            <span className="min-w-0 truncate font-mono" title={label}>
              {label}
            </span>
          )}
          {expandable && (
            <button
              type="button"
              onClick={onToggle}
              className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-ink-secondary hover:bg-raised hover:text-ink"
              aria-expanded={expanded}
            >
              {expanded ? (
                <span className="inline-flex items-center gap-0.5">
                  <ChevronUp size={12} /> Collapse
                </span>
              ) : (
                <span className="inline-flex items-center gap-0.5">
                  <ChevronDown size={12} /> Show full command
                </span>
              )}
            </button>
          )}
        </div>
        {expanded && expandable && (
          <div className="mt-2 min-w-0">
            <pre className="max-h-64 min-w-0 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-inset px-2.5 py-2 font-mono text-[12px] text-ink">
              {command}
            </pre>
            <div className="mt-1.5 flex items-center gap-2">
              <button
                type="button"
                onClick={onCopy}
                className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-ink-secondary hover:bg-raised hover:text-ink"
              >
                {copied ? <Check size={12} className="text-success" /> : <Copy size={12} />}
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function ActivityChip({
  message,
  onOpenGroup,
}: {
  message: Message;
  onOpenGroup?: (groupId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const tool = message.tool;
  if (!tool) return null;

  const copy = () => {
    void navigator.clipboard?.writeText(visibleCommand(tool));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };

  return (
    <ActivityChipView
      message={message}
      expanded={expanded}
      copied={copied}
      onToggle={() => setExpanded((value) => !value)}
      onCopy={copy}
      onOpenGroup={onOpenGroup}
    />
  );
}
