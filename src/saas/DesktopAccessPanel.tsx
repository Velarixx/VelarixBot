import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Loader2, Monitor, RefreshCw, ShieldOff } from "lucide-react";

import {
  createDesktopAccessTransport,
  DESKTOP_VIEW_PATH,
  type DesktopAccessOutcome,
  type DesktopAccessTransport,
} from "./desktop-access-transport";

const buttonClass =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-line bg-raised px-4 py-2.5 text-[14px] font-medium text-ink transition-colors hover:bg-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-60";
const primaryButtonClass =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-action-primary px-4 py-2.5 text-[14px] font-medium text-white transition-colors hover:bg-action-primary-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:bg-action-primary-disabled disabled:text-white";

export type DesktopAccessModel =
  | { status: "checking" }
  | { status: "idle" }
  | { status: "requesting" }
  | { status: "active"; expiresAt: number }
  | { status: "denied" }
  | { status: "unavailable"; retry: "check" | "request" | "revoke" }
  | { status: "expired" }
  | { status: "revoking" }
  | { status: "revoked" };

export function DesktopAccessPanelView({
  model,
  onRequest,
  onRetry,
  onRevoke,
  feedbackRef,
}: {
  model: DesktopAccessModel;
  onRequest(): void;
  onRetry(): void;
  onRevoke(): void;
  feedbackRef?: RefObject<HTMLDivElement | null>;
}) {
  const pending = model.status === "checking" || model.status === "requesting" || model.status === "revoking";
  const alert = model.status === "denied" || model.status === "unavailable" || model.status === "expired";
  const feedback = model.status !== "idle";
  return (
    <section aria-labelledby="remote-desktop-heading" className="mt-5 rounded-xl border border-line bg-surface p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-2xl">
          <div className="mb-2 flex items-center gap-2 text-[13px] font-semibold text-accent">
            <Monitor size={17} aria-hidden="true" />
            Scoped access
          </div>
          <h2 id="remote-desktop-heading" className="text-[18px] font-semibold">Remote desktop</h2>
          <p className="mt-1 text-[14px] leading-6 text-ink-secondary">
            Request brief, view-only access to your tenant workspace. Access stays in this secure browser session.
          </p>
        </div>
        {model.status === "idle" || model.status === "revoked" || model.status === "expired" || model.status === "denied" ? (
          <button type="button" className={primaryButtonClass} onClick={onRequest}>Request access</button>
        ) : null}
      </div>

      {feedback && (
        <div
          ref={feedbackRef}
          tabIndex={pending ? undefined : -1}
          role={alert ? "alert" : "status"}
          aria-live={alert ? "assertive" : "polite"}
          aria-busy={pending || undefined}
          className="mt-4 rounded-lg border border-line bg-app px-4 py-3 text-[14px] outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          {model.status === "checking" && <span className="flex items-center gap-2"><Loader2 size={16} className="animate-spin" data-saas-progress-indicator="true" aria-hidden="true" />Checking remote desktop access…</span>}
          {model.status === "requesting" && <span className="flex items-center gap-2"><Loader2 size={16} className="animate-spin" data-saas-progress-indicator="true" aria-hidden="true" />Requesting scoped access…</span>}
          {model.status === "active" && (
            <div className="grid gap-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span>Remote desktop access is active for less than two minutes.</span>
                <button type="button" className={buttonClass} onClick={onRevoke}><ShieldOff size={16} aria-hidden="true" />Revoke access</button>
              </div>
              <img
                src={DESKTOP_VIEW_PATH}
                alt="Live view of your tenant desktop"
                className="max-h-[60vh] w-full rounded-lg border border-line bg-black object-contain"
                referrerPolicy="no-referrer"
              />
            </div>
          )}
          {model.status === "denied" && <span>Remote desktop access isn’t available for this workspace.</span>}
          {model.status === "expired" && <span>Remote desktop access expired. Request a new scoped grant to continue.</span>}
          {model.status === "revoking" && <span className="flex items-center gap-2"><Loader2 size={16} className="animate-spin" data-saas-progress-indicator="true" aria-hidden="true" />Revoking remote desktop access…</span>}
          {model.status === "revoked" && <span>Remote desktop access was revoked.</span>}
          {model.status === "unavailable" && (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span>We couldn’t update remote desktop access. No access details are shown.</span>
              <button type="button" className={buttonClass} onClick={onRetry}><RefreshCw size={16} aria-hidden="true" />Try again</button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function outcomeModel(outcome: DesktopAccessOutcome, fallback: "idle" | "denied"): DesktopAccessModel {
  if (outcome.kind === "active") return { status: "active", expiresAt: outcome.expiresAt };
  if (outcome.kind === "denied") return { status: "denied" };
  if (outcome.kind === "absent") return { status: fallback };
  return { status: "unavailable", retry: fallback === "idle" ? "check" : "request" };
}

export function DesktopAccessPanel({
  onSessionLost,
  transport: injectedTransport,
}: {
  onSessionLost(): void;
  transport?: DesktopAccessTransport;
}) {
  const transport = useMemo(() => injectedTransport ?? createDesktopAccessTransport(), [injectedTransport]);
  const [model, setModel] = useState<DesktopAccessModel>({ status: "checking" });
  const feedbackRef = useRef<HTMLDivElement>(null);
  const operation = useRef<AbortController | null>(null);

  const run = useCallback(async (kind: "check" | "request" | "revoke") => {
    operation.current?.abort();
    const controller = new AbortController();
    operation.current = controller;
    setModel({ status: kind === "check" ? "checking" : kind === "request" ? "requesting" : "revoking" });
    if (kind === "revoke") {
      const outcome = await transport.revoke(controller.signal);
      if (controller.signal.aborted) return;
      if (outcome === "unauthenticated") return onSessionLost();
      setModel(outcome === "revoked" ? { status: "revoked" } : { status: "unavailable", retry: "revoke" });
      return;
    }
    const outcome = kind === "check"
      ? await transport.check(controller.signal)
      : await transport.request(controller.signal);
    if (controller.signal.aborted) return;
    if (outcome.kind === "unauthenticated") return onSessionLost();
    setModel(outcomeModel(outcome, kind === "check" ? "idle" : "denied"));
  }, [onSessionLost, transport]);

  useEffect(() => {
    void run("check");
    return () => operation.current?.abort();
  }, [run]);

  useEffect(() => {
    if (model.status !== "active") return;
    const delay = Math.max(0, Math.min(model.expiresAt - Date.now(), 2_147_483_647));
    const timeout = globalThis.setTimeout(() => setModel({ status: "expired" }), delay);
    return () => globalThis.clearTimeout(timeout);
  }, [model]);

  useEffect(() => {
    if (!["checking", "requesting", "revoking", "idle"].includes(model.status)) feedbackRef.current?.focus();
  }, [model.status]);

  return (
    <DesktopAccessPanelView
      model={model}
      onRequest={() => void run("request")}
      onRetry={() => void run(model.status === "unavailable" ? model.retry : "request")}
      onRevoke={() => void run("revoke")}
      feedbackRef={feedbackRef}
    />
  );
}
