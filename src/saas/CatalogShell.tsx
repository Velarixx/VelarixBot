import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { Bot, Loader2, LogOut, Plus, RefreshCw, ShieldCheck } from "lucide-react";
import { MAUS_COLORS } from "@/lib/mascot";
import {
  createCatalogCreationCoordinator,
  type CatalogCreationCoordinator,
  type CreationModel,
} from "./catalog-creation";
import { catalogReducer, INITIAL_CATALOG_MODEL, type CatalogModel } from "./catalog-state";
import { createCatalogTransport, type CatalogTransport } from "./catalog-transport";
import { createBotCreationTransport, type BotCreationTransport } from "./create-bot-transport";
import { DesktopAccessPanel } from "./DesktopAccessPanel";

const buttonClass =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-line bg-raised px-4 py-2.5 text-[14px] font-medium text-ink transition-colors hover:bg-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
const primaryButtonClass =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-[14px] font-medium text-white transition-colors hover:bg-accent/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-60";

export interface CatalogShellViewProps {
  model: CatalogModel;
  creation: CreationModel;
  onCreate(): void;
  onRetryCreation(): void;
  onRetry(): void;
  onRequestSignOut(): void;
  headingRef?: RefObject<HTMLHeadingElement | null>;
  feedbackRef?: RefObject<HTMLDivElement | null>;
  signOutTriggerRef?: RefObject<HTMLButtonElement | null>;
  desktopAccess?: ReactNode;
}

export function CatalogShellView({
  model,
  creation,
  onCreate,
  onRetryCreation,
  onRetry,
  onRequestSignOut,
  headingRef,
  feedbackRef,
  signOutTriggerRef,
  desktopAccess,
}: CatalogShellViewProps) {
  const hidden = model.status === "auth_lost";
  const creationPending = creation.status === "creating" || creation.status === "refetching";
  const creationDisabled = creationPending || creation.status === "quota" || (
    creation.status === "failure" && creation.retry === "refresh"
  );
  const creationAvailable = model.status === "empty" || model.status === "populated";
  return (
    <main
      className="min-h-full bg-app px-5 py-8 text-ink"
      data-saas-catalog="true"
      aria-busy={model.status === "loading" || creationPending || undefined}
    >
      <div className="mx-auto w-full max-w-5xl">
        <header className="flex flex-wrap items-start justify-between gap-4 border-b border-line pb-5">
          <div>
            <div className="mb-2 flex items-center gap-2 text-[13px] font-semibold text-accent">
              <ShieldCheck size={17} aria-hidden="true" />
              VelarixBot SaaS
            </div>
            <h1 ref={headingRef} tabIndex={-1} className="text-[24px] font-semibold tracking-tight outline-none">
              Bot catalog
            </h1>
            <p className="mt-1 text-[14px] text-ink-secondary">Create and view your tenant’s available bots.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {creationAvailable && (
              <button
                type="button"
                className={primaryButtonClass}
                onClick={onCreate}
                disabled={creationDisabled}
                aria-describedby={creation.status === "idle" ? undefined : "creation-feedback"}
              >
                {creationPending
                  ? <Loader2 size={16} className="animate-spin" data-saas-progress-indicator="true" aria-hidden="true" />
                  : <Plus size={16} aria-hidden="true" />}
                {creationPending ? "Creating…" : "Create bot"}
              </button>
            )}
            <button ref={signOutTriggerRef} type="button" className={buttonClass} onClick={onRequestSignOut}>
              <LogOut size={16} aria-hidden="true" />
              Sign out
            </button>
          </div>
        </header>

        {desktopAccess}

        {creation.status !== "idle" && (
          <div
            id="creation-feedback"
            ref={feedbackRef}
            tabIndex={creation.status === "success" || creation.status === "quota" || creation.status === "failure" ? -1 : undefined}
            role={creation.status === "quota" || creation.status === "failure" ? "alert" : "status"}
            aria-live={creation.status === "quota" || creation.status === "failure" ? "assertive" : "polite"}
            className="mt-5 rounded-lg border border-line bg-surface px-4 py-3 text-[14px] outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            {creation.status === "creating" && "Creating your bot…"}
            {creation.status === "refetching" && "Bot request completed. Refreshing the catalog…"}
            {creation.status === "success" && "Bot created. The catalog is up to date."}
            {creation.status === "quota" && "Bot limit reached. You can’t create another bot right now."}
            {creation.status === "failure" && (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span>We couldn’t finish creating the bot. No details were retained.</span>
                <button type="button" className={buttonClass} onClick={onRetryCreation}>Try again</button>
              </div>
            )}
          </div>
        )}

        {model.status === "loading" && (
          <section role="status" aria-live="polite" className="flex min-h-56 items-center justify-center gap-3 text-ink-secondary">
            <Loader2
              size={20}
              className="animate-spin text-accent"
              data-saas-progress-indicator="true"
              aria-hidden="true"
            />
            Loading bot catalog…
          </section>
        )}
        {model.status === "empty" && (
          <section role="status" aria-live="polite" className="flex min-h-56 flex-col items-center justify-center text-center">
            <Bot size={30} className="mb-3 text-ink-secondary" aria-hidden="true" />
            <h2 className="text-[18px] font-semibold">Create your first bot</h2>
            <p className="mt-1 max-w-md text-[14px] text-ink-secondary">Start with a safe default bot. You can view it here after creation.</p>
            <button
              type="button"
              className={`${primaryButtonClass} mt-5`}
              onClick={onCreate}
              disabled={creationDisabled}
              aria-describedby={creation.status === "idle" ? undefined : "creation-feedback"}
            >
              {creationPending
                ? <Loader2 size={16} className="animate-spin" data-saas-progress-indicator="true" aria-hidden="true" />
                : <Plus size={16} aria-hidden="true" />}
              {creationPending ? "Creating…" : "Create first bot"}
            </button>
          </section>
        )}
        {model.status === "populated" && (
          <section aria-labelledby="available-bots-heading" className="py-6">
            <div role="status" aria-live="polite" className="sr-only">
              {model.items.length} {model.items.length === 1 ? "bot" : "bots"} loaded.
            </div>
            <h2 id="available-bots-heading" className="mb-4 text-[16px] font-semibold">Available bots</h2>
            <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {model.items.map((item, index) => (
                <li key={`${item.name}\u0000${item.title}\u0000${index}`} className="rounded-xl border border-line bg-surface p-4 shadow-sm">
                  <div className="mb-3 flex items-center gap-3">
                    <span
                      className="size-3 shrink-0 rounded-full"
                      style={{ backgroundColor: MAUS_COLORS[item.color] }}
                      aria-hidden="true"
                    />
                    <h3 className="min-w-0 truncate text-[16px] font-semibold">{item.name}</h3>
                  </div>
                  {item.title && <p className="text-[14px] font-medium text-ink">{item.title}</p>}
                  {item.description && <p className="mt-1 text-[13px] leading-5 text-ink-secondary">{item.description}</p>}
                </li>
              ))}
            </ul>
          </section>
        )}
        {model.status === "error" && (
          <section role="alert" aria-live="assertive" className="flex min-h-56 flex-col items-center justify-center text-center">
            <h2 className="text-[18px] font-semibold">Bot catalog unavailable</h2>
            <p className="mt-1 max-w-md text-[14px] text-ink-secondary">We couldn’t load the catalog. No protected data is shown.</p>
            <button type="button" className={`${buttonClass} mt-5`} onClick={onRetry}>
              <RefreshCw size={16} aria-hidden="true" />
              Try again
            </button>
          </section>
        )}
        {hidden && <div role="status" aria-live="assertive" className="sr-only">Session ended. Protected catalog content was cleared.</div>}
      </div>
    </main>
  );
}

export interface CatalogShellProps {
  onSessionLost(): void;
  onRequestSignOut(): void;
  signOutTriggerRef: RefObject<HTMLButtonElement | null>;
  transport?: CatalogTransport;
  creationTransport?: BotCreationTransport;
}

export function CatalogShell({
  onSessionLost,
  onRequestSignOut,
  signOutTriggerRef,
  transport: injectedTransport,
  creationTransport: injectedCreationTransport,
}: CatalogShellProps) {
  const transport = useMemo(() => injectedTransport ?? createCatalogTransport(), [injectedTransport]);
  const creationTransport = useMemo(
    () => injectedCreationTransport ?? createBotCreationTransport(),
    [injectedCreationTransport],
  );
  const [model, dispatch] = useReducer(catalogReducer, INITIAL_CATALOG_MODEL);
  const [creation, setCreation] = useState<CreationModel>({ status: "idle" });
  const [loadVersion, setLoadVersion] = useState(0);
  const requestIdRef = useRef(0);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const feedbackRef = useRef<HTMLDivElement>(null);

  const creationCoordinator = useMemo<CatalogCreationCoordinator>(() => (
    createCatalogCreationCoordinator(creationTransport, transport, {
      setCreation,
      replaceCatalog: (items) => dispatch({ type: "catalog_replaced", items }),
      clearProtectedState: () => dispatch({ type: "protected_cleared" }),
      onSessionLost,
    })
  ), [creationTransport, onSessionLost, transport]);

  useEffect(() => () => creationCoordinator.abort(), [creationCoordinator]);

  useEffect(() => {
    const controller = new AbortController();
    const requestId = ++requestIdRef.current;
    let current = true;
    dispatch({ type: "load_started", requestId });
    void transport.load(controller.signal)
      .then((outcome) => {
        if (!current || controller.signal.aborted || requestId !== requestIdRef.current) return;
        if (outcome.kind === "unauthenticated") {
          dispatch({ type: "auth_lost", requestId });
          onSessionLost();
        } else if (outcome.kind === "success") {
          dispatch({ type: "load_succeeded", requestId, items: outcome.items });
        } else {
          dispatch({ type: "load_failed", requestId });
        }
      })
      .catch(() => {
        if (current && !controller.signal.aborted && requestId === requestIdRef.current) {
          dispatch({ type: "load_failed", requestId });
        }
      });
    return () => {
      current = false;
      controller.abort();
    };
  }, [loadVersion, onSessionLost, transport]);

  useEffect(() => {
    if (model.status === "empty" || model.status === "populated" || model.status === "error") {
      // Preserve the session boundary's reviewed sign-out focus restoration.
      // Fresh loads and retries leave focus on body once their prior control
      // unmounts, so their result still receives deterministic focus.
      if (document.activeElement === document.body || document.activeElement === null) {
        headingRef.current?.focus();
      }
    }
  }, [model.status]);

  useEffect(() => {
    if (creation.status === "success" || creation.status === "quota" || creation.status === "failure") {
      feedbackRef.current?.focus();
    }
  }, [creation.status]);

  const retry = useCallback(() => {
    setCreation({ status: "idle" });
    setLoadVersion((version) => version + 1);
  }, []);
  const create = useCallback(() => void creationCoordinator.start(), [creationCoordinator]);
  const retryCreation = useCallback(() => void creationCoordinator.retry(), [creationCoordinator]);
  return (
    <CatalogShellView
      model={model}
      creation={creation}
      onCreate={create}
      onRetryCreation={retryCreation}
      onRetry={retry}
      onRequestSignOut={onRequestSignOut}
      headingRef={headingRef}
      feedbackRef={feedbackRef}
      signOutTriggerRef={signOutTriggerRef}
      desktopAccess={<DesktopAccessPanel onSessionLost={onSessionLost} />}
    />
  );
}
