import { useEffect, useId, useRef, useState } from "react";
import { ExternalLink, X } from "lucide-react";
import { api, useStore, type Message } from "@/state/store";
import { shouldOfferDesktop } from "../../server/handoff";
import { cn } from "@/lib/cn";

const LETTERS = ["A", "B", "C", "D", "E", "F"];

export type CardResponse = {
  answer: string;
  always?: boolean;
  persistScope?: "bot" | "workspace";
  secret?: string;
  dismiss?: boolean;
};

export type CardDispatchAction =
  | ({
      type: "answerCard";
      botId: string;
      messageId: string;
    } & Omit<CardResponse, "dismiss"> & CardResponseCallbacks)
  | ({
      type: "dismissCard";
      botId: string;
      messageId: string;
    } & CardResponseCallbacks);

type CardResponseCallbacks = {
  onSuccess?: () => void;
  onError?: (message: string) => void;
};

type SubmissionRef = { current: boolean };

export function approvalResponse(scope: "once" | "bot" | "workspace"): CardResponse {
  const response: CardResponse = { answer: "Allow once" };
  if (scope === "once") return response;
  if (scope === "bot") return { ...response, always: true };
  return { ...response, always: true, persistScope: "workspace" };
}

export function submitCardResponse({
  botId,
  messageId,
  liveRequest,
  response,
  submitting,
  dispatch,
  setSubmitting,
  setResponseError,
  setRetainedResponse,
  clearSecret,
}: {
  botId: string;
  messageId: string;
  liveRequest: boolean;
  response: CardResponse;
  submitting: SubmissionRef;
  dispatch: (action: CardDispatchAction) => void;
  setSubmitting: (value: boolean) => void;
  setResponseError: (value: string | null) => void;
  setRetainedResponse: (value: CardResponse | null) => void;
  clearSecret: () => void;
}): boolean {
  if (!liveRequest) {
    if (response.dismiss) {
      dispatch({ type: "dismissCard", botId, messageId });
    } else {
      dispatch({ type: "answerCard", botId, messageId, ...response });
    }
    if (response.secret) clearSecret();
    return true;
  }
  if (submitting.current) return false;

  submitting.current = true;
  setSubmitting(true);
  setResponseError(null);
  setRetainedResponse(response);
  const onSuccess = () => {
    submitting.current = false;
    setSubmitting(false);
    setResponseError(null);
    setRetainedResponse(null);
    if (response.secret) clearSecret();
  };
  const onError = (error: string) => {
    submitting.current = false;
    setSubmitting(false);
    setResponseError(error);
  };
  if (response.dismiss) {
    dispatch({ type: "dismissCard", botId, messageId, onSuccess, onError });
  } else {
    dispatch({ type: "answerCard", botId, messageId, ...response, onSuccess, onError });
  }
  return true;
}

export function OptionCardFeedback({
  submitting,
  responseError,
  onRetry,
}: {
  submitting: boolean;
  responseError: string | null;
  onRetry?: () => void;
}) {
  return (
    <>
      {submitting && (
        <div role="status" aria-live="polite" className="mt-3 text-[13px] text-ink-secondary">
          Submitting response…
        </div>
      )}

      {responseError && onRetry && (
        <div role="alert" className="mt-3 rounded-lg border border-danger/30 bg-danger/5 px-3 py-2.5 text-[13px] text-ink">
          <div className="font-medium">Couldn’t send your response.</div>
          <div className="mt-0.5 text-ink-secondary">{responseError}</div>
          <button
            type="button"
            onClick={onRetry}
            className="mt-2 font-medium text-danger hover:underline"
          >
            Retry response
          </button>
        </div>
      )}
    </>
  );
}

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
  const [submitting, setSubmitting] = useState(false);
  const [responseError, setResponseError] = useState<string | null>(null);
  const [retainedResponse, setRetainedResponse] = useState<CardResponse | null>(null);
  const openedDesktop = useRef(false);
  const submittingRef = useRef(false);
  const headingId = useId();
  const card = message.card;
  const permission = card?.requestType === "permission" || (!card?.requestType && !!card?.requestId && card.title === "Approval needed");
  const credential = card?.requestType === "credential";
  const secret = card?.requestType === "secret";
  const suggestion = card?.requestType === "suggestion";
  const setup = card?.requestType === "setup";
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

  const submitResponse = (response: CardResponse) => {
    submitCardResponse({
      botId,
      messageId: message.id,
      liveRequest: !!card.requestId,
      response,
      submitting: submittingRef,
      dispatch,
      setSubmitting,
      setResponseError,
      setRetainedResponse,
      clearSecret: () => setCustom(""),
    });
  };

  const answer = (text: string, response: Omit<CardResponse, "answer"> = {}) => {
    const answer = text.trim();
    if (!answer) return;
    submitResponse({ answer, ...response });
  };

  const answerSecret = () => {
    if (!custom.trim()) return;
    answer("••••", { secret: custom });
  };

  return (
    <div
      role="group"
      aria-labelledby={headingId}
      aria-busy={submitting}
      className="w-full max-w-[840px] rounded-2xl border border-hairline/50 bg-card p-4"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <div id={headingId} className="text-[16px] font-semibold text-ink">{card.title}</div>
          <div className="mt-0.5 text-[14px] text-ink-secondary">
            {card.subtitle}
          </div>
        </div>
        <button
          type="button"
          aria-label={card.requestId ? "Deny and dismiss request" : "Dismiss card"}
          disabled={submitting}
          onClick={() => submitResponse({ answer: "Dismissed", dismiss: true })}
          className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
        >
          <X size={16} aria-hidden="true" />
        </button>
      </div>

      <OptionCardFeedback
        submitting={submitting}
        responseError={responseError}
        onRetry={retainedResponse ? () => submitResponse(retainedResponse) : undefined}
      />

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
            disabled={submitting || !!card.answered}
            onClick={() => permission && opt === "Allow once" ? submitResponse(approvalResponse("once")) : answer(opt)}
            className={cn(
              "flex w-full items-center gap-3 px-3 py-3 text-left text-[15px] text-ink",
              i > 0 && "border-t border-hairline/40",
              card.answered === opt || retainedResponse?.answer === opt
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
            disabled={submitting}
            placeholder="Value stays off the transcript"
            className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2.5 text-[15px] text-ink placeholder:text-ink-secondary focus:outline-none focus:border-hairline"
          />
          <button
            type="submit"
            disabled={submitting || !custom.trim()}
            className="mt-2 w-full rounded-lg bg-accent py-2.5 text-[14px] font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? "Submitting…" : "Submit"}
          </button>
        </form>
      )}

      {!card.answered && !credential && !secret && !suggestion && !setup && (
        <input
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          disabled={submitting}
          onKeyDown={(e) => e.key === "Enter" && !submitting && answer(custom)}
          placeholder="Type your own answer"
          className="mt-3 w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2.5 text-[15px] text-ink placeholder:text-ink-secondary focus:outline-none focus:border-hairline"
        />
      )}

      {!card.answered && permission && (
        <div className="mt-3 flex flex-col items-start gap-1.5">
          <button
            type="button"
            disabled={submitting}
            onClick={() => submitResponse(approvalResponse("bot"))}
            className="text-[13px] text-ink-secondary hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
          >
            Always allow for this bot
          </button>
          <button
            type="button"
            disabled={submitting}
            onClick={() => submitResponse(approvalResponse("workspace"))}
            className="text-[12px] text-ink-secondary/70 hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
          >
            Advanced: always allow for all bots
          </button>
        </div>
      )}
    </div>
  );
}
