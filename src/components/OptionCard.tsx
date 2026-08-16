import { useEffect, useRef, useState } from "react";
import { ExternalLink, X } from "lucide-react";
import { api, useStore, type Message } from "@/state/store";
import { shouldOfferDesktop } from "../../server/handoff";
import { cn } from "@/lib/cn";

const LETTERS = ["A", "B", "C", "D", "E", "F"];

export function OptionCard({
  botId,
  message,
}: {
  botId: string;
  message: Message;
}) {
  const { state, dispatch } = useStore();
  const [custom, setCustom] = useState("");
  const [joining, setJoining] = useState(false);
  const openedDesktop = useRef(false);
  const card = message.card;
  const permission = card?.requestType === "permission" || (!card?.requestType && !!card?.requestId && card.title === "Approval needed");
  const credential = card?.requestType === "credential";
  const secret = card?.requestType === "secret";
  const suggestion = card?.requestType === "suggestion";
  const bot = state.bots.find((b) => b.id === botId);
  const offerDesktop = credential && shouldOfferDesktop(bot?.computer, state.config?.box.configured === true);
  const connectUrl = card?.connectUrl;

  const openDesktop = () => {
    setJoining(true);
    api(`/api/bots/${botId}/computer/join`, { method: "POST" })
      .then((result) => {
        if (result.joinUrl) window.open(result.joinUrl);
      })
      .catch(() => {})
      .finally(() => setJoining(false));
  };

  useEffect(() => {
    if (!offerDesktop || !card || card.answered || card.dismissed || openedDesktop.current) return;
    openedDesktop.current = true;
    openDesktop();
  }, [offerDesktop, card?.answered, card?.dismissed, botId]);

  if (!card || card.dismissed) return null;

  const answer = (text: string) => {
    if (!text.trim()) return;
    dispatch({ type: "answerCard", botId, messageId: message.id, answer: text.trim() });
  };

  const answerSecret = () => {
    if (!custom.trim()) return;
    dispatch({
      type: "answerCard",
      botId,
      messageId: message.id,
      answer: "••••",
      secret: custom,
    });
    setCustom("");
  };

  return (
    <div className="w-full max-w-[840px] rounded-2xl border border-hairline/50 bg-card p-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-[16px] font-semibold text-ink">{card.title}</div>
          <div className="mt-0.5 text-[14px] text-ink-secondary">
            {card.subtitle}
          </div>
        </div>
        <button
          onClick={() =>
            dispatch({ type: "dismissCard", botId, messageId: message.id })
          }
          className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink"
        >
          <X size={16} />
        </button>
      </div>

      {offerDesktop && !card.answered && (
        <button
          onClick={openDesktop}
          disabled={joining}
          className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg bg-raised py-2.5 text-[14px] text-ink hover:bg-raised-hover disabled:opacity-50"
        >
          <ExternalLink size={14} />
          {joining ? "Opening desktop…" : "Open desktop"}
        </button>
      )}

      {connectUrl && !card.answered && (
        <button
          onClick={() => window.open(connectUrl)}
          className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg bg-raised py-2.5 text-[14px] text-ink hover:bg-raised-hover"
        >
          <ExternalLink size={14} />
          Open connect page
        </button>
      )}

      {!secret && card.options.length > 0 && (
      <div className="mt-3 overflow-hidden rounded-lg border border-hairline/40">
        {card.options.map((opt, i) => (
          <button
            key={opt}
            disabled={!!card.answered}
            onClick={() => answer(opt)}
            className={cn(
              "flex w-full items-center gap-3 px-3 py-3 text-left text-[15px] text-ink",
              i > 0 && "border-t border-hairline/40",
              card.answered === opt
                ? "bg-raised"
                : "hover:bg-raised/60 disabled:hover:bg-transparent",
            )}
          >
            <span className="flex size-6 items-center justify-center rounded-md bg-raised text-[12px] font-medium text-ink-secondary">
              {LETTERS[i]}
            </span>
            {opt}
          </button>
        ))}
      </div>
      )}

      {secret && !card.answered && (
        <form
          className="mt-3"
          onSubmit={(e) => {
            e.preventDefault();
            answerSecret();
          }}
        >
          <input
            type="password"
            autoComplete="off"
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            placeholder="Value stays off the transcript"
            className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2.5 text-[15px] text-ink placeholder:text-ink-secondary focus:outline-none focus:border-hairline"
          />
          <button
            type="submit"
            className="mt-2 w-full rounded-lg bg-accent py-2.5 text-[14px] font-medium text-white"
          >
            Submit
          </button>
        </form>
      )}

      {!card.answered && !credential && !secret && !suggestion && (
        <input
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && answer(custom)}
          placeholder="Type your own answer"
          className="mt-3 w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2.5 text-[15px] text-ink placeholder:text-ink-secondary focus:outline-none focus:border-hairline"
        />
      )}

      {!card.answered && permission && (
        <div className="mt-3 flex flex-col items-start gap-1.5">
          <button
            onClick={() =>
              dispatch({ type: "answerCard", botId, messageId: message.id, answer: "Allow once", always: true })
            }
            className="text-[13px] text-ink-secondary hover:text-ink"
          >
            Always allow for this bot
          </button>
          <button
            onClick={() =>
              dispatch({
                type: "answerCard",
                botId,
                messageId: message.id,
                answer: "Allow once",
                always: true,
                persistScope: "workspace",
              })
            }
            className="text-[12px] text-ink-secondary/70 hover:text-ink"
          >
            Advanced: always allow for all bots
          </button>
        </div>
      )}
    </div>
  );
}
