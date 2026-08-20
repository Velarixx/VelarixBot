import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { Github, Loader2, LockKeyhole, LogOut, ShieldCheck } from "lucide-react";
import {
  INITIAL_SESSION_MODEL,
  createAttemptGuard,
  modelForReturnedOutcome,
  sessionReducer,
  type AttemptGuard,
  type SessionModel,
} from "./session-state";
import {
  consumeAuthorizationResult,
  createSessionTransport,
  type SessionTransport,
} from "./session-transport";

const FOCUS_ON_ENTRY = new Set([
  "sign_in_required",
  "sign_in_declined",
  "callback_rejected",
  "session_ended",
  "service_unavailable",
  "signed_out",
  "sign_out_unconfirmed",
]);

export interface SessionBoundaryActions {
  checkSession(): void;
  beginSignIn(): void;
  cancelSignIn(): void;
  requestSignOut(): void;
  cancelSignOut(): void;
  confirmSignOut(): void;
}

interface SessionBoundaryViewProps {
  model: SessionModel;
  actions: SessionBoundaryActions;
  authenticatedContent?: ReactNode;
  headingRef?: RefObject<HTMLHeadingElement | null>;
  signOutTriggerRef?: RefObject<HTMLButtonElement | null>;
  cancelRef?: RefObject<HTMLButtonElement | null>;
  dialogRef?: RefObject<HTMLDivElement | null>;
  onDialogKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
}

const primaryButton =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-action-primary px-4 py-2.5 text-[14px] font-semibold text-white transition-colors hover:bg-action-primary-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-wait disabled:bg-action-primary-disabled disabled:text-white";
const secondaryButton =
  "inline-flex min-h-11 items-center justify-center rounded-lg border border-line bg-raised px-4 py-2.5 text-[14px] font-medium text-ink transition-colors hover:bg-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

function BoundaryFrame({
  children,
  busy = false,
}: {
  children: React.ReactNode;
  busy?: boolean;
}) {
  return (
    <main
      className="flex min-h-full items-center justify-center bg-app px-5 py-10 text-ink"
      aria-busy={busy || undefined}
      data-session-boundary="true"
    >
      <section className="w-full max-w-md rounded-2xl border border-line bg-surface p-6 shadow-lg">
        <div className="mb-5 flex size-11 items-center justify-center rounded-xl bg-accent/10 text-accent">
          <LockKeyhole size={22} aria-hidden="true" />
        </div>
        {children}
      </section>
    </main>
  );
}

function Actions({ children }: { children: React.ReactNode }) {
  return <div className="mt-6 flex flex-col gap-2 sm:flex-row">{children}</div>;
}

export function SessionBoundaryView({
  model,
  actions,
  authenticatedContent,
  headingRef,
  signOutTriggerRef,
  cancelRef,
  dialogRef,
  onDialogKeyDown,
}: SessionBoundaryViewProps) {
  const heading = (text: string) => (
    <h1 ref={headingRef} tabIndex={-1} className="text-[20px] font-semibold tracking-tight outline-none">
      {text}
    </h1>
  );
  const description = (text: string) => (
    <p className="mt-2 text-[14px] leading-6 text-ink-secondary">{text}</p>
  );

  switch (model.status) {
    case "session_checking":
      return (
        <BoundaryFrame busy>
          <div role="status" aria-live="polite" className="flex items-center gap-3">
            <Loader2
              size={20}
              className="animate-spin text-accent"
              data-saas-progress-indicator="true"
              aria-hidden="true"
            />
            <div>
              {heading("Checking your session…")}
              {description("Product access stays closed until this check completes.")}
            </div>
          </div>
        </BoundaryFrame>
      );
    case "sign_in_required":
      return (
        <BoundaryFrame>
          {heading("Sign in to continue")}
          {description("Continue with GitHub to complete the secure sign-in handoff.")}
          <Actions>
            <button type="button" className={primaryButton} onClick={actions.beginSignIn}>
              <Github size={17} aria-hidden="true" />
              Continue with GitHub
            </button>
            <button type="button" className={secondaryButton} onClick={actions.checkSession}>
              Retry session check
            </button>
          </Actions>
        </BoundaryFrame>
      );
    case "sign_in_pending":
      return (
        <BoundaryFrame busy>
          <div role="status" aria-live="polite">
            {heading("Continue in GitHub to sign in")}
            {description("The sign-in handoff has started. This window will stay closed to product data.")}
          </div>
          <Actions>
            <button type="button" className={secondaryButton} onClick={actions.cancelSignIn}>
              Cancel
            </button>
          </Actions>
        </BoundaryFrame>
      );
    case "sign_in_declined":
      return (
        <BoundaryFrame>
          <div role="alert">
            {heading("Sign-in wasn’t completed")}
            {description("Nothing was changed. You can start a fresh sign-in attempt when you’re ready.")}
          </div>
          <Actions>
            <button type="button" className={primaryButton} onClick={actions.beginSignIn}>Try again</button>
            <button type="button" className={secondaryButton} onClick={actions.cancelSignIn}>Back</button>
          </Actions>
        </BoundaryFrame>
      );
    case "callback_rejected":
      return (
        <BoundaryFrame>
          <div role="alert">
            {heading("We couldn’t verify that sign-in attempt")}
            {description("Start again to create a new secure sign-in attempt.")}
          </div>
          <Actions>
            <button type="button" className={primaryButton} onClick={actions.beginSignIn}>Start again</button>
            <button type="button" className={secondaryButton} onClick={actions.cancelSignIn}>Back to sign in</button>
          </Actions>
        </BoundaryFrame>
      );
    case "session_ended":
      return (
        <BoundaryFrame>
          <div role="alert">
            {heading("Your session ended")}
            {description("Sign in again to continue. Protected content remains hidden.")}
          </div>
          <Actions>
            <button type="button" className={primaryButton} onClick={actions.beginSignIn}>Sign in again</button>
          </Actions>
        </BoundaryFrame>
      );
    case "service_unavailable":
      return (
        <BoundaryFrame>
          <div role={model.manualAttempt ? "alert" : "status"} aria-live={model.manualAttempt ? "assertive" : "polite"}>
            {heading("We can’t check your session right now")}
            {description("Product access remains closed. Try the session check again.")}
          </div>
          <Actions>
            <button type="button" className={primaryButton} onClick={actions.checkSession}>Try again</button>
          </Actions>
        </BoundaryFrame>
      );
    case "authenticated":
      if (authenticatedContent) return authenticatedContent;
      return (
        <BoundaryFrame>
          <div role="status" aria-live="polite">
            <div className="mb-3 flex items-center gap-2 text-success">
              <ShieldCheck size={19} aria-hidden="true" />
              <span className="text-[13px] font-semibold">Session confirmed</span>
            </div>
            {heading("Signed in")}
            {description("Product access is not enabled yet. Tenant-safe routes require a separate review.")}
          </div>
          <Actions>
            <button ref={signOutTriggerRef} type="button" className={secondaryButton} onClick={actions.requestSignOut}>
              <LogOut size={16} aria-hidden="true" />
              Sign out
            </button>
          </Actions>
        </BoundaryFrame>
      );
    case "sign_out_confirm":
    case "sign_out_pending": {
      const pending = model.status === "sign_out_pending";
      return (
        <BoundaryFrame busy={pending}>
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="sign-out-title"
            aria-describedby="sign-out-description"
            aria-busy={pending || undefined}
            onKeyDown={onDialogKeyDown}
          >
            <div role={pending ? "status" : undefined} aria-live={pending ? "polite" : undefined}>
              <h1
                id="sign-out-title"
                ref={headingRef}
                tabIndex={-1}
                className="flex items-center gap-2 text-[20px] font-semibold outline-none"
              >
                {pending && (
                  <Loader2
                    size={20}
                    className="animate-spin text-accent"
                    data-saas-progress-indicator="true"
                    aria-hidden="true"
                  />
                )}
                {pending ? "Signing out…" : "Sign out on this device?"}
              </h1>
              <p id="sign-out-description" className="mt-2 text-[14px] leading-6 text-ink-secondary">
                {pending
                  ? "Protected content is hidden while sign-out is confirmed."
                  : "Unsent work will be cleared from this client."}
              </p>
            </div>
            {!pending && (
              <Actions>
                <button ref={cancelRef} type="button" className={secondaryButton} onClick={actions.cancelSignOut}>Cancel</button>
                <button type="button" className={primaryButton} onClick={actions.confirmSignOut}>Sign out</button>
              </Actions>
            )}
          </div>
        </BoundaryFrame>
      );
    }
    case "signed_out":
      return (
        <BoundaryFrame>
          <div role="status" aria-live="polite">
            {heading("You’re signed out")}
            {description("Protected content and client session context have been cleared.")}
          </div>
          <Actions>
            <button type="button" className={primaryButton} onClick={actions.beginSignIn}>Sign in again</button>
          </Actions>
        </BoundaryFrame>
      );
    case "sign_out_unconfirmed":
      return (
        <BoundaryFrame>
          <div role="alert">
            {heading("We couldn’t confirm sign-out")}
            {description("Your work is hidden. Try sign-out again before using this device for another account, or close this window.")}
          </div>
          <Actions>
            <button type="button" className={primaryButton} onClick={actions.confirmSignOut}>Try sign-out again</button>
          </Actions>
        </BoundaryFrame>
      );
  }
}

function keepFocusInDialog(event: KeyboardEvent<HTMLDivElement>, dialog: HTMLDivElement | null): void {
  if (event.key !== "Tab" || !dialog) return;
  const controls = [...dialog.querySelectorAll<HTMLElement>("button:not([disabled]), [href], [tabindex]:not([tabindex='-1'])")];
  if (controls.length === 0) {
    event.preventDefault();
    return;
  }
  const first = controls[0];
  const last = controls[controls.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

export interface SessionBoundaryProps {
  transport?: SessionTransport;
  renderAuthenticated?: (controls: {
    onSessionLost(): void;
    onRequestSignOut(): void;
    signOutTriggerRef: RefObject<HTMLButtonElement | null>;
  }) => ReactNode;
}

export function SessionBoundary({
  transport: injectedTransport,
  renderAuthenticated,
}: SessionBoundaryProps = {}) {
  const transport = useMemo(() => injectedTransport ?? createSessionTransport(), [injectedTransport]);
  const [returnedResult] = useState(() => {
    if (typeof window === "undefined") return { outcome: "none" as const, scrubbed: true };
    return consumeAuthorizationResult(window.location, window.history);
  });
  const [model, dispatch] = useReducer(
    sessionReducer,
    returnedResult.scrubbed ? modelForReturnedOutcome(returnedResult.outcome) : INITIAL_SESSION_MODEL,
  );
  const headingRef = useRef<HTMLHeadingElement>(null);
  const signOutTriggerRef = useRef<HTMLButtonElement>(null);
  const restoreSignOutFocusRef = useRef(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const aliveRef = useRef(true);
  const probeGuard = useRef<AttemptGuard>(createAttemptGuard());
  const signInGuard = useRef<AttemptGuard>(createAttemptGuard());
  const signOutGuard = useRef<AttemptGuard>(createAttemptGuard());

  useEffect(() => {
    // React development StrictMode replays effect setup/cleanup. Restore the
    // live marker on each setup so the second, real setup can accept results.
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const checkSession = useCallback(async (manual: boolean) => {
    if (!probeGuard.current.tryStart()) return;
    dispatch({ type: "check_requested", manual });
    const outcome = await transport.probe();
    probeGuard.current.reset();
    if (!aliveRef.current) return;
    dispatch({
      type:
        outcome === "authenticated"
          ? "check_authenticated"
          : outcome === "unauthenticated"
            ? "check_unauthenticated"
            : "check_unavailable",
    });
  }, [transport]);

  useEffect(() => {
    if (!returnedResult.scrubbed) return;
    if (returnedResult.outcome === "none" || returnedResult.outcome === "authenticated") {
      void checkSession(false);
    }
  }, [checkSession, returnedResult]);

  useEffect(() => {
    if (model.status === "sign_out_confirm") {
      cancelRef.current?.focus();
    } else if (model.status === "sign_out_pending") {
      headingRef.current?.focus();
    } else if (model.status === "authenticated" && restoreSignOutFocusRef.current) {
      restoreSignOutFocusRef.current = false;
      signOutTriggerRef.current?.focus();
    } else if (FOCUS_ON_ENTRY.has(model.status)) {
      headingRef.current?.focus();
    }
  }, [model.status]);

  const beginSignIn = useCallback(() => {
    if (!signInGuard.current.tryStart()) return;
    dispatch({ type: "sign_in_started" });
    if (transport.beginSignIn() === "unavailable") {
      signInGuard.current.reset();
      dispatch({ type: "check_unavailable" });
    }
  }, [transport]);

  const cancelSignIn = useCallback(() => {
    signInGuard.current.reset();
    dispatch({ type: "sign_in_cancelled" });
  }, []);

  const cancelSignOut = useCallback(() => {
    restoreSignOutFocusRef.current = true;
    dispatch({ type: "sign_out_cancelled" });
  }, []);

  const confirmSignOut = useCallback(async () => {
    if (!signOutGuard.current.tryStart()) return;
    dispatch({ type: "sign_out_confirmed" });
    const outcome = await transport.signOut();
    if (outcome === "unconfirmed") signOutGuard.current.reset();
    if (!aliveRef.current) return;
    dispatch({ type: outcome === "confirmed" ? "sign_out_succeeded" : "sign_out_failed" });
  }, [transport]);

  const actions = useMemo<SessionBoundaryActions>(() => ({
    checkSession: () => void checkSession(true),
    beginSignIn,
    cancelSignIn,
    requestSignOut: () => dispatch({ type: "sign_out_requested" }),
    cancelSignOut,
    confirmSignOut: () => void confirmSignOut(),
  }), [beginSignIn, cancelSignIn, cancelSignOut, checkSession, confirmSignOut]);

  const onSessionLost = useCallback(() => {
    dispatch({ type: "check_unauthenticated" });
  }, []);

  const authenticatedContent = model.status === "authenticated" && renderAuthenticated
    ? renderAuthenticated({
        onSessionLost,
        onRequestSignOut: actions.requestSignOut,
        signOutTriggerRef,
      })
    : undefined;

  const onDialogKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" && model.status === "sign_out_confirm") {
      event.preventDefault();
      cancelSignOut();
      return;
    }
    keepFocusInDialog(event, dialogRef.current);
  }, [cancelSignOut, model.status]);

  return (
    <SessionBoundaryView
      model={model}
      actions={actions}
      authenticatedContent={authenticatedContent}
      headingRef={headingRef}
      signOutTriggerRef={signOutTriggerRef}
      cancelRef={cancelRef}
      dialogRef={dialogRef}
      onDialogKeyDown={onDialogKeyDown}
    />
  );
}
