// Apps hub — Sessions (create/list/revoke, user_id=velarix_<botId>) are the
// mount path. Connect/ck_ is optional fallback. enabledApps is the per-bot
// mount gate (empty = none). Built-in harness MCP is not inventory.
import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw, X } from "lucide-react";
import { api, useStore } from "@/state/store";
import {
  CONNECTOR_PATHS,
  enabledAppSlugs,
  filterCatalogCards,
  hubUnconfiguredCopy,
  sessionUserId,
  toggleEnabledApp,
  type CatalogCard,
  type ComposioSession,
} from "@/lib/apps";
import { cn } from "@/lib/cn";

function ServiceIcon({ card }: { card: CatalogCard }) {
  // 0 = official logo, 1 = favicon by domain, 2 = monogram
  const [stage, setStage] = useState(card.logo ? 0 : card.domain ? 1 : 2);
  if (stage === 0 && card.logo) {
    return <img src={card.logo} alt="" className="size-8 rounded-md" onError={() => setStage(1)} />;
  }
  if (stage === 1 && card.domain) {
    return (
      <img
        src={`https://www.google.com/s2/favicons?domain=${card.domain}&sz=64`}
        alt=""
        className="size-8 rounded-md"
        onError={() => setStage(2)}
      />
    );
  }
  return (
    <div className="flex size-8 items-center justify-center rounded-md bg-raised text-[13px] font-semibold text-ink-secondary">
      {card.label.slice(0, 1).toUpperCase()}
    </div>
  );
}

export function PluginsPanel() {
  const { state, dispatch } = useStore();
  const bot = state.bots.find((b) => b.id === state.selectedId) ?? state.bots[0];
  const [cards, setCards] = useState<CatalogCard[] | null>(null);
  const [source, setSource] = useState<"api" | "curated">("curated");
  const [configured, setConfigured] = useState(true);
  const [sessionsConfigured, setSessionsConfigured] = useState(false);
  const [sessions, setSessions] = useState<ComposioSession[]>([]);
  const [status, setStatus] = useState<Record<string, { connected: boolean }>>({});
  const [busySlug, setBusySlug] = useState<string | null>(null);
  const [sessionBusy, setSessionBusy] = useState<"create" | string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const unconfigured = hubUnconfiguredCopy();

  const refreshSessions = useCallback(() => {
    return api(CONNECTOR_PATHS.sessions)
      .then((r) => {
        setSessionsConfigured(Boolean(r.configured));
        setSessions(Array.isArray(r.sessions) ? r.sessions : []);
      })
      .catch(() => {});
  }, []);

  const refreshStatus = useCallback((slugs: string[]) => {
    if (!slugs.length) return Promise.resolve();
    setRefreshing(true);
    return api(CONNECTOR_PATHS.status(slugs, bot?.id))
      .then((r) => setStatus(r.services ?? {}))
      .catch(() => {})
      .finally(() => setRefreshing(false));
  }, [bot?.id]);

  useEffect(() => {
    let alive = true;
    api(CONNECTOR_PATHS.catalog)
      .then((r) => {
        if (!alive) return;
        setCards(r.cards ?? []);
        setSource(r.source ?? "curated");
        setConfigured(Boolean(r.configured));
        if (r.configured) void refreshStatus((r.cards ?? []).map((c: CatalogCard) => c.slug).slice(0, 40));
        void refreshSessions();
      })
      .catch((e) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [refreshStatus, refreshSessions]);

  const connect = (slug: string) => {
    setBusySlug(slug);
    setError(null);
    api(CONNECTOR_PATHS.authorize(slug, bot?.id), { method: "POST", body: JSON.stringify(bot?.id ? { botId: bot.id } : {}) })
      .then(({ url }) => {
        window.open(url);
        // the user finishes OAuth in the browser; poll a few times to catch it
        let tries = 0;
        const timer = setInterval(() => {
          void refreshStatus([slug]);
          if (++tries >= 6) clearInterval(timer);
        }, 5000);
      })
      .catch((e) => setError(e.message))
      .finally(() => setBusySlug(null));
  };

  const disconnect = (slug: string) => {
    setBusySlug(slug);
    api(CONNECTOR_PATHS.disconnect(slug, bot?.id), { method: "DELETE" })
      .then(() => refreshStatus([slug]))
      .catch((e) => setError(e.message))
      .finally(() => setBusySlug(null));
  };

  const createSession = () => {
    if (!bot) return;
    setSessionBusy("create");
    setError(null);
    api(CONNECTOR_PATHS.sessions, { method: "POST", body: JSON.stringify({ botId: bot.id }) })
      .then((r) => {
        if (r.error) throw new Error(r.error);
        return refreshSessions();
      })
      .catch((e) => setError(e.message))
      .finally(() => setSessionBusy(null));
  };

  const revokeSession = (sessionId: string) => {
    setSessionBusy(sessionId);
    setError(null);
    api(CONNECTOR_PATHS.revoke(sessionId), { method: "DELETE" })
      .then(() => refreshSessions())
      .catch((e) => setError(e.message))
      .finally(() => setSessionBusy(null));
  };

  const toggleEnable = (slug: string) => {
    if (!bot) return;
    dispatch({
      type: "updateBot",
      botId: bot.id,
      patch: { enabledApps: toggleEnabledApp(enabledAppSlugs(bot), slug) },
    });
  };

  const visible = filterCatalogCards(cards ?? [], search);

  return (
    <div
      className="absolute inset-0 z-20 flex items-center justify-center bg-black/40"
      onClick={() => dispatch({ type: "togglePlugins", open: false })}
    >
      <div
        className="animate-pop-in flex max-h-[80%] w-[640px] flex-col rounded-2xl border border-hairline/50 bg-panel p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <div className="text-[17px] font-semibold text-ink">Apps</div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => refreshStatus(visible.map((c) => c.slug).slice(0, 40))}
              className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink"
              title="Refresh connection status"
            >
              <RefreshCw size={15} className={cn(refreshing && "animate-spin")} />
            </button>
            <button
              onClick={() => dispatch({ type: "togglePlugins", open: false })}
              className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink"
              aria-label="Close apps"
            >
              <X size={18} />
            </button>
          </div>
        </div>
        <div className="mt-1 text-[13px] text-ink-secondary">
          Sessions are the mount path — one per bot, identity{" "}
          <code className="text-ink">{bot ? sessionUserId(bot.id) : "velarix_<botId>"}</code>.
          Connect key is optional. Enable is per bot
          {bot ? (
            <>
              {" "}
              — currently <span className="text-ink">{bot.name}</span>
            </>
          ) : null}
          . Empty enable is none, not all.
        </div>

        {!configured && (
          <div className="mt-3 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-[13px] text-warning">
            {unconfigured.title}{" "}
            <button
              className="underline"
              onClick={() => {
                dispatch({ type: "togglePlugins", open: false });
                dispatch({ type: "toggleAppSettings", open: true });
              }}
            >
              {unconfigured.action}
            </button>{" "}
            to connect apps.
          </div>
        )}
        {configured && source === "curated" && (
          <div className="mt-3 text-[12px] text-ink-secondary">
            Showing a curated set.{" "}
            <button
              className="underline hover:text-ink"
              onClick={() => {
                dispatch({ type: "togglePlugins", open: false });
                dispatch({ type: "toggleAppSettings", open: true });
              }}
            >
              Add a Composio API key
            </button>{" "}
            to browse the full catalog.
          </div>
        )}
        {error && <div className="mt-2 text-[12px] text-danger">{error}</div>}

        {bot && (
          <section className="mt-3 rounded-xl border border-hairline/40 bg-card p-3" aria-label="Composio sessions">
            <div className="flex items-center justify-between gap-2">
              <div>
                <div className="text-[13px] font-medium text-ink">Sessions</div>
                <div className="text-[12px] text-ink-secondary">
                  user_id <code className="text-ink">{sessionUserId(bot.id)}</code>
                </div>
              </div>
              <button
                type="button"
                disabled={!sessionsConfigured || sessionBusy === "create"}
                onClick={createSession}
                className="rounded-lg bg-raised px-3 py-1.5 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50"
              >
                {sessionBusy === "create" ? "Creating…" : "Create session"}
              </button>
            </div>
            {sessions.length === 0 ? (
              <p className="mt-2 text-[12px] text-ink-secondary">
                No sessions. Create one for this bot, or leave empty — no key/session is honest empty.
              </p>
            ) : (
              <ul className="mt-2 flex flex-col gap-1">
                {sessions.map((s) => (
                  <li key={s.sessionId} className="flex items-center justify-between gap-2 text-[12px]">
                    <span className="min-w-0 truncate text-ink">
                      {s.userId}
                      <span className="ml-2 text-ink-secondary">{s.sessionId}</span>
                    </span>
                    <button
                      type="button"
                      disabled={sessionBusy === s.sessionId}
                      onClick={() => revokeSession(s.sessionId)}
                      className="shrink-0 text-ink-secondary hover:text-danger"
                    >
                      {sessionBusy === s.sessionId ? "Revoking…" : "Revoke"}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search apps"
          className="mt-3 w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none"
        />

        <div className="mt-3 min-h-0 flex-1 overflow-y-auto rounded-xl border border-hairline/40">
          {cards === null ? (
            <div className="flex items-center justify-center gap-2 py-8 text-[13px] text-ink-secondary">
              <Loader2 size={14} className="animate-spin" /> Loading catalog…
            </div>
          ) : (
            visible.map((card, i) => {
              const connected = status[card.slug]?.connected;
              const busy = busySlug === card.slug;
              const enabled = bot ? enabledAppSlugs(bot).includes(card.slug) : false;
              return (
                <div
                  key={card.slug}
                  className={cn(
                    "flex items-center gap-3 bg-card px-4 py-3",
                    i > 0 && "border-t border-hairline/40",
                  )}
                >
                  <ServiceIcon card={card} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-[14px] font-medium text-ink">
                      {card.label}
                      {connected && <span className="size-1.5 rounded-full bg-success" title="Connected" />}
                    </div>
                    <div className="truncate text-[12px] text-ink-secondary">{card.blurb}</div>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    disabled={!bot}
                    aria-checked={enabled}
                    aria-label={`${enabled ? "Disable" : "Enable"} ${card.label}${bot ? ` for ${bot.name}` : ""}`}
                    onClick={() => toggleEnable(card.slug)}
                    className={cn(
                      "relative h-[22px] w-[38px] shrink-0 rounded-full transition-colors disabled:opacity-50",
                      enabled ? "bg-accent" : "bg-raised",
                    )}
                  >
                    <span
                      className={cn(
                        "absolute top-[3px] size-4 rounded-full bg-white transition-all",
                        enabled ? "left-[17px]" : "left-[3px]",
                      )}
                    />
                  </button>
                  <button
                    disabled={!configured || busy}
                    onClick={() => (connected ? disconnect(card.slug) : connect(card.slug))}
                    className={cn(
                      "w-[92px] shrink-0 rounded-lg py-1.5 text-[13px] disabled:opacity-50",
                      connected
                        ? "bg-raised text-ink-secondary hover:text-danger"
                        : "bg-raised text-ink hover:bg-raised-hover",
                    )}
                  >
                    {busy ? (
                      <Loader2 size={13} className="mx-auto animate-spin" />
                    ) : connected ? (
                      "Disconnect"
                    ) : (
                      "Connect"
                    )}
                  </button>
                </div>
              );
            })
          )}
          {cards !== null && visible.length === 0 && (
            <div className="py-8 text-center text-[13px] text-ink-secondary">
              {cards.length === 0 ? "No apps in the catalog." : "No apps match."}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
