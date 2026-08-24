import { useEffect, useRef, useState } from "react";
import { ArrowDown, Loader2, Monitor, Square } from "lucide-react";
import { useStore, formatTime, type Bot, type Message } from "@/state/store";
import { BotFace } from "./Avatar";
import { stateForBot } from "@/lib/mascot";
import { ChatMarkdown } from "./ChatMarkdown";
import { OptionCard } from "./OptionCard";
import { Composer } from "./Composer";
import { ModelPicker } from "./ModelPicker";
import { ActivityChip } from "./ActivityChip";
import { UserAttachments } from "./UserAttachments";
import { cn } from "@/lib/cn";
import { splitAttachedFiles } from "@/lib/chat-message";
import { formatCompactTokens, formatUsageCost, stateLabel, type BotState } from "@/lib/product";

const stateTone: Record<BotState, string> = { IDLE: "bg-raised text-ink-secondary", RUNNING: "bg-accent/15 text-accent", DONE: "bg-success/15 text-success", BLOCKED: "bg-danger/15 text-danger", NEEDS_INPUT: "bg-warning/15 text-warning" };

/** Long user messages collapse behind a fade so pasted walls of text don't
 * bury the conversation; bots get full markdown. */
const USER_COLLAPSE_CHARS = 600;
const USER_COLLAPSE_LINES = 8;

function Bubble({ message }: { message: Message }) {
  const user = message.role === "user";
  const [expanded, setExpanded] = useState(false);
  const text = message.text ?? "";
  const { body, paths } = splitAttachedFiles(text);
  const collapsible =
    user && !expanded && (body.length > USER_COLLAPSE_CHARS || body.split("\n").length > USER_COLLAPSE_LINES);
  return (
    <div className={cn("flex w-full min-w-0", user ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "min-w-0 max-w-[70%] overflow-hidden rounded-2xl px-4 py-2.5 text-[15px] leading-relaxed",
          user ? "bg-bubble-user text-ink" : "bg-card text-ink",
        )}
      >
        {user ? (
          <UserBubbleBody body={body} paths={paths} collapsible={collapsible} onExpand={() => setExpanded(true)} />
        ) : (
          <ChatMarkdown text={text} />
        )}
      </div>
    </div>
  );
}

function UserBubbleBody({
  body,
  paths,
  collapsible,
  onExpand,
}: {
  body: string;
  paths: string[];
  collapsible: boolean;
  onExpand: () => void;
}) {
  return (
    <>
      {body ? (
        <div
          className={cn(
            "min-w-0 overflow-hidden whitespace-pre-wrap break-words [overflow-wrap:anywhere]",
            collapsible && "max-h-40 overflow-hidden [mask-image:linear-gradient(to_bottom,black_60%,transparent)]",
          )}
        >
          {body}
        </div>
      ) : null}
      <UserAttachments paths={paths} />
      {collapsible && (
        <button onClick={onExpand} className="mt-1 text-[12.5px] text-ink-secondary hover:text-ink">
          Show full message
        </button>
      )}
    </>
  );
}

function ScreenFrame({ png, mime }: { png: string; mime?: string }) {
  return (
    <div className="flex justify-start">
      <img
        src={`data:${mime ?? "image/png"};base64,${png}`}
        alt="Bot's screen"
        className="max-w-[70%] rounded-2xl border border-hairline/40"
      />
    </div>
  );
}

function StreamingBubble({ text }: { text: string }) {
  return (
    <div className="flex w-full justify-start">
      <div className="min-w-0 max-w-[70%] overflow-hidden rounded-2xl bg-card px-4 py-2.5 text-[15px] leading-relaxed text-ink">
        <ChatMarkdown text={text} streaming />
        <span className="ml-0.5 inline-block h-[14px] w-[2px] animate-pulse bg-ink-secondary align-middle" />
      </div>
    </div>
  );
}

/** "Working for 12s" that ticks by mutating textContent on an interval —
 * no React commit per second while a turn streams (upstream trick). */
function WorkingTimer({ since }: { since: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const tick = () => {
      if (ref.current) ref.current.textContent = `Working for ${Math.max(0, Math.round((Date.now() - since) / 1000))}s`;
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [since]);
  return <span ref={ref} className="text-[12.5px] text-ink-secondary" />;
}

export function ChatView({ bot }: { bot: Bot }) {
  const { state, dispatch } = useStore();
  const scrollRef = useRef<HTMLDivElement>(null);

  const streaming = state.streaming[bot.threadId];
  const provisioning = state.provisioning[bot.id];
  const mascotMotion = state.mascotMotion?.botId === bot.id ? state.mascotMotion : null;
  const participants = (bot.threadParticipants ?? [])
    .map((id) => state.bots.find((item) => item.id === id))
    .filter((item): item is Bot => Boolean(item));

  // Scroll pinning: follow the bottom while the user hasn't scrolled away.
  // Follow breaks ONLY on an upward user gesture (wheel/touch), never on
  // scroll position checks — streamed content growth flickers "at bottom"
  // false for a frame, and breaking there kills follow permanently
  // (upstream-verified failure). Scrolling back to the end re-arms it.
  const [follow, setFollow] = useState(true);
  const touchY = useRef(0);

  useEffect(() => setFollow(true), [bot.id]);
  useEffect(() => {
    if (follow) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [bot.id, bot.messages.length, streaming, bot.busy, follow]);

  const atEnd = () => {
    const el = scrollRef.current;
    return !el || el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };
  const jumpToLatest = () => {
    setFollow(true);
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  };

  const first = bot.messages[0];

  return (
    <main className="relative flex h-full min-w-0 flex-1 flex-col bg-app">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-3">
        <button
          onClick={() => dispatch({ type: "toggleSettings" })}
          className="flex min-w-0 items-center gap-2.5 rounded-lg px-1.5 py-1 hover:bg-raised/50"
          title="Bot settings"
        >
          <BotFace
            bot={bot}
            state={stateForBot(bot)}
            size={28}
            motion={mascotMotion?.kind ?? "none"}
            motionKey={mascotMotion?.nonce ?? 0}
          />
          <span className="min-w-0 text-left">
            <span className="block text-[15px] font-semibold text-ink">{bot.name}</span>
            {participants.length > 1 && (
              <span className="block truncate text-[11px] text-ink-secondary">
                With {participants.filter((p) => p.id !== bot.id).map((p) => p.name).join(", ")}
              </span>
            )}
          </span>
          {bot.busy && <Loader2 size={14} className="animate-spin text-ink-secondary" />}
          <span title={bot.stateDetail} className={cn("rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide", stateTone[bot.state ?? "IDLE"])}>{stateLabel(bot.state ?? "IDLE")}</span>
        </button>
        <div className="flex items-center gap-2">
          <span title="Lifetime provider-reported usage" className="hidden text-[11px] text-ink-secondary xl:inline">{formatCompactTokens((bot.usage?.input ?? 0) + (bot.usage?.output ?? 0))} tokens · {formatUsageCost(bot.usage?.cost ?? null)}</span>
          {bot.busy && (
            <button
              onClick={() => dispatch({ type: "interrupt", botId: bot.id })}
              className="flex items-center gap-1.5 rounded-full border border-hairline/40 bg-raised/60 px-2.5 py-1 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink"
              title="Stop this turn"
            >
              <Square size={12} className="fill-current" />
              Stop
            </button>
          )}
          <ModelPicker bot={bot} />
          <button
            onClick={() => dispatch({ type: "toggleComputer" })}
            className={cn(
              "rounded-md p-1.5 hover:bg-raised",
              state.computerOpen ? "text-accent" : "text-ink-secondary hover:text-ink",
            )}
            title="Bot's computer"
          >
            <Monitor size={18} />
          </button>
        </div>
      </div>

      {/* Error banner */}
      {state.error && (
        <div className="mx-auto w-full max-w-[900px] px-5">
          <div className="mb-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[13px] text-danger">
            {state.error}
          </div>
        </div>
      )}

      {/* Blocked state banner */}
      {bot.state === "BLOCKED" && bot.stateDetail && (
        <div className="mx-auto w-full max-w-[900px] px-5">
          <div className="mb-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2" data-state-code={bot.stateCode}>
            <div className="mb-1 text-[13px] font-semibold text-danger">Bot is blocked</div>
            <div className="text-[13px] text-danger/90">{bot.stateDetail}</div>
          </div>
        </div>
      )}

      {/* Messages */}
      <div
        ref={scrollRef}
        className="min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-5 [overflow-anchor:none]"
        onWheel={(e) => {
          if (e.deltaY < 0) setFollow(false);
          else if (atEnd()) setFollow(true);
        }}
        onTouchStart={(e) => (touchY.current = e.touches[0]?.clientY ?? 0)}
        onTouchMove={(e) => {
          const y = e.touches[0]?.clientY ?? 0;
          if (y > touchY.current + 4) setFollow(false);
          else if (atEnd()) setFollow(true);
        }}
        onScroll={() => {
          if (!follow && atEnd()) setFollow(true);
        }}
      >
        <div className="mx-auto flex min-w-0 max-w-[900px] flex-col gap-3 pb-4">
          {first && (
            <div className="py-3 text-center text-[13px] text-ink-secondary">
              Today {formatTime(first.at)}
            </div>
          )}
          {bot.messages.map((m) => {
            switch (m.kind) {
              case "options":
                return <OptionCard key={m.id} botId={bot.id} message={m} />;
              case "activity":
                return (
                  <ActivityChip
                    key={m.id}
                    message={m}
                    onOpenGroup={(id) => dispatch({ type: "selectGroup", id })}
                  />
                );
              case "screen":
                return m.png ? <ScreenFrame key={m.id} png={m.png} mime={m.mime} /> : null;
              default:
                return <Bubble key={m.id} message={m} />;
            }
          })}
          {provisioning && (
            <div className="flex justify-start">
              <div className="flex items-center gap-2 rounded-full border border-hairline/40 bg-panel px-3 py-1.5 text-[13px] text-ink-secondary">
                <Loader2 size={13} className="animate-spin" />
                Setting up this bot's computer…
              </div>
            </div>
          )}
          {streaming ? (
            <StreamingBubble text={streaming} />
          ) : (
            bot.busy && (
              <div className="flex justify-start">
                <div className="flex items-center gap-2.5 rounded-2xl bg-raised px-4 py-3">
                  <span className="flex items-center gap-1.5">
                    <span className="size-1.5 animate-bounce rounded-full bg-ink-secondary [animation-delay:0ms]" />
                    <span className="size-1.5 animate-bounce rounded-full bg-ink-secondary [animation-delay:150ms]" />
                    <span className="size-1.5 animate-bounce rounded-full bg-ink-secondary [animation-delay:300ms]" />
                  </span>
                  <WorkingTimer since={[...bot.messages].reverse().find((m) => m.role === "user")?.at ?? Date.now()} />
                </div>
              </div>
            )
          )}
        </div>
      </div>

      {/* Reading scrollback while new content arrives — one tap back to live */}
      {!follow && (bot.busy || Boolean(streaming)) && (
        <button
          onClick={jumpToLatest}
          className="absolute bottom-24 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-hairline/40 bg-raised px-3 py-1.5 text-[12.5px] text-ink shadow-lg hover:bg-raised-hover"
        >
          <ArrowDown size={13} /> Jump to latest
        </button>
      )}

      <Composer bot={bot} />
    </main>
  );
}
