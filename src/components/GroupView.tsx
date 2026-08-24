// Slim A ⇄ B DM view. Renders the mirrored ask_bot / delegate_bot
// exchange. Not a room, bulletin, or voice product.
import { useEffect, useRef, useState } from "react";
import { ArrowDown } from "lucide-react";
import { useStore, formatTime, type Group } from "@/state/store";
import { ChatMarkdown } from "./ChatMarkdown";
import { ActivityChip } from "./ActivityChip";
import { UserAttachments } from "./UserAttachments";
import { splitAttachedFiles } from "@/lib/chat-message";
import { cn } from "@/lib/cn";

function GroupUserText({ text }: { text: string }) {
  const { body, paths } = splitAttachedFiles(text);
  return (
    <>
      {body ? (
        <div className="min-w-0 overflow-hidden whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
          {body}
        </div>
      ) : null}
      <UserAttachments paths={paths} />
    </>
  );
}

function dayLabel(at: number): string {
  const d = new Date(at);
  const now = new Date();
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}

export function GroupView({ group }: { group: Group }) {
  const { state } = useStore();
  const streaming = state.streaming[group.threadId];
  const scrollRef = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  const members = group.memberIds
    .map((id) => state.bots.find((b) => b.id === id))
    .filter((b): b is NonNullable<typeof b> => Boolean(b));

  useEffect(() => {
    setFollow(true);
  }, [group.id]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !follow) return;
    el.scrollTo({ top: el.scrollHeight });
  }, [group.id, group.messages.length, streaming, follow]);

  const atEnd = () => {
    const el = scrollRef.current;
    return !el || el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const first = group.messages[0];

  return (
    <main className="relative flex h-full min-w-0 flex-1 flex-col bg-app">
      <header className="flex items-center gap-3 border-b border-hairline/40 px-5 py-3">
        <div className="min-w-0">
          <h1 className="truncate text-[16px] font-semibold text-ink">{group.name}</h1>
          <p className="truncate text-[12.5px] text-ink-secondary">
            {members.map((m) => m.name).join(" and ") || "Direct message"}
          </p>
        </div>
      </header>

      <div
        ref={scrollRef}
        className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-5 pt-4"
        onWheel={(e) => {
          if (e.deltaY < 0) setFollow(false);
          else if (atEnd()) setFollow(true);
        }}
        onScroll={() => {
          if (!follow && atEnd()) setFollow(true);
        }}
      >
        <div className="mx-auto flex min-w-0 max-w-[900px] flex-col gap-3 pb-8">
          {first && (
            <div className="py-3 text-center text-[13px] text-ink-secondary">
              {dayLabel(first.at)} {formatTime(first.at)}
            </div>
          )}
          {group.messages.length === 0 && (
            <div className="py-16 text-center text-[14px] text-ink-secondary">
              Messages between these bots appear here.
            </div>
          )}
          {group.messages.map((m) => {
            if (m.kind === "activity") return <ActivityChip key={m.id} message={m} />;
            if (m.kind !== "text" || !m.text) return null;
            const user = m.role === "user";
            return (
              <div key={m.id} className={cn("flex w-full min-w-0 flex-col", user ? "items-end" : "items-start")}>
                {!user && m.from && (
                  <div className="mb-1 px-1 text-[12px] font-medium text-ink-secondary">{m.from.name}</div>
                )}
                <div
                  className={cn(
                    "min-w-0 max-w-[70%] overflow-hidden rounded-2xl px-4 py-2.5 text-[15px] leading-relaxed",
                    user ? "bg-bubble-user text-ink" : "bg-card text-ink",
                  )}
                >
                  {user ? <GroupUserText text={m.text} /> : <ChatMarkdown text={m.text} />}
                </div>
              </div>
            );
          })}
          {streaming && (
            <div className="flex w-full justify-start">
              <div className="min-w-0 max-w-[70%] overflow-hidden rounded-2xl bg-card px-4 py-2.5 text-[15px] leading-relaxed text-ink">
                <ChatMarkdown text={streaming} streaming />
              </div>
            </div>
          )}
        </div>
      </div>

      {!follow && (
        <button
          onClick={() => {
            setFollow(true);
            scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
          }}
          className="absolute bottom-8 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-hairline/40 bg-raised px-3 py-1.5 text-[12.5px] text-ink shadow-lg hover:bg-raised-hover"
        >
          <ArrowDown size={13} /> Jump to latest
        </button>
      )}
    </main>
  );
}
