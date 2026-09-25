export function HistoryControls({ history, onEarlier }: {
  history: { hasEarlier: boolean; loading: boolean; error: string | null; latest: boolean; earlier(): Promise<void>; later(): void };
  onEarlier?: () => void;
}) {
  return <div className="flex flex-wrap items-center justify-center gap-3 text-[13px] text-ink-secondary">
    {history.hasEarlier && <button disabled={history.loading} className="rounded-lg px-3 py-2 hover:bg-raised disabled:opacity-50" onClick={() => { onEarlier?.(); void history.earlier(); }}>{history.loading ? "Loading history…" : "Show earlier messages"}</button>}
    {!history.latest && <button className="rounded-lg px-3 py-2 hover:bg-raised" onClick={history.later}>Show newer messages</button>}
    {history.error && <span role="alert" className="text-danger">Couldn’t load history. {history.error} Try again using Show earlier messages.</span>}
  </div>;
}
