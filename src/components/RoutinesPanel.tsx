import { useEffect, useState, type FormEvent } from "react";
import { CalendarClock, Loader2, Pause, Play, Plus, Trash2, X } from "lucide-react";
import { api, useStore, type Routine, type RoutineSchedule } from "@/state/store";

function scheduleLabel(schedule: RoutineSchedule) {
  return schedule.kind === "daily" ? `Daily at ${schedule.time}` : `Every ${schedule.everyMinutes} min`;
}

export function RoutinesPanel() {
  const { state, dispatch } = useStore();
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [botId, setBotId] = useState(state.selectedId || state.bots[0]?.id || "");
  const [everyMinutes, setEveryMinutes] = useState(60);

  useEffect(() => {
    api("/api/routines").then(({ routines }) => dispatch({ type: "routinesLoaded", routines })).catch((e) => setError(e.message));
  }, [dispatch]);

  const mutate = async (routine: Routine, patch: Partial<Routine>) => {
    setError(null);
    try {
      const { routine: saved } = await api(`/api/routines/${routine.id}`, { method: "PATCH", body: JSON.stringify(patch) });
      dispatch({ type: "routineSaved", routine: saved });
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (!botId || !name.trim() || !prompt.trim()) return;
    setSaving(true); setError(null);
    try {
      const { routine } = await api("/api/routines", { method: "POST", body: JSON.stringify({ botId, name: name.trim(), prompt: prompt.trim(), schedule: { kind: "interval", everyMinutes } }) });
      dispatch({ type: "routineSaved", routine });
      setName(""); setPrompt(""); setCreating(false);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setSaving(false); }
  };

  const remove = async (routine: Routine) => {
    setError(null);
    try { await api(`/api/routines/${routine.id}`, { method: "DELETE" }); dispatch({ type: "routineDeleted", routineId: routine.id }); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  return <aside className="animate-panel-in flex h-full w-[420px] shrink-0 flex-col border-l border-hairline/40 bg-panel">
    <div className="flex items-center justify-between px-4 py-3"><CalendarClock size={18} className="text-ink-secondary" /><span className="text-[15px] font-semibold text-ink">Routines</span><button aria-label="Close routines" onClick={() => dispatch({ type: "toggleRoutines", open: false })} className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink"><X size={18} /></button></div>
    <div className="flex-1 overflow-y-auto px-4 pb-4">
      <p className="text-[13px] leading-relaxed text-ink-secondary">Schedule a prompt for a bot. Routines persist locally and run only while the harness is running.</p>
      {error && <div className="mt-3 rounded-lg border border-danger/30 bg-danger/10 p-2 text-[12px] text-danger">{error}</div>}
      {creating ? <form onSubmit={create} className="mt-4 space-y-3 rounded-xl bg-card p-4">
        <label className="block text-[12px] text-ink-secondary">Bot<select value={botId} onChange={(e) => setBotId(e.target.value)} className="mt-1 w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[14px] text-ink">{state.bots.map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}</select></label>
        <label className="block text-[12px] text-ink-secondary">Name<input autoFocus required value={name} onChange={(e) => setName(e.target.value)} placeholder="Morning briefing" className="mt-1 w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[14px] text-ink" /></label>
        <label className="block text-[12px] text-ink-secondary">Prompt<textarea required rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Summarize today's priorities…" className="mt-1 w-full resize-none rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[14px] text-ink" /></label>
        <label className="block text-[12px] text-ink-secondary">Run every (minutes)<input type="number" min={1} value={everyMinutes} onChange={(e) => setEveryMinutes(Math.max(1, Number(e.target.value)))} className="mt-1 w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[14px] text-ink" /></label>
        <div className="flex justify-end gap-2"><button type="button" onClick={() => setCreating(false)} className="rounded-lg px-3 py-2 text-[13px] text-ink-secondary">Cancel</button><button disabled={saving} className="flex items-center gap-2 rounded-lg bg-accent px-3 py-2 text-[13px] font-medium text-white disabled:opacity-50">{saving && <Loader2 size={13} className="animate-spin" />}Create</button></div>
      </form> : <button onClick={() => setCreating(true)} className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg bg-accent py-2.5 text-[14px] font-medium text-white"><Plus size={16} />New routine</button>}
      <div className="mt-4 space-y-2">{state.routines.length === 0 && !creating ? <div className="rounded-xl border border-dashed border-hairline/50 p-6 text-center text-[13px] text-ink-secondary">No routines yet.</div> : state.routines.map((routine) => {
        const bot = state.bots.find((item) => item.id === routine.botId);
        return <div key={routine.id} className="rounded-xl bg-card p-3.5"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><div className="truncate text-[14px] font-medium text-ink">{routine.name}</div><div className="mt-0.5 text-[12px] text-ink-secondary">{bot?.name ?? "Deleted bot"} · {scheduleLabel(routine.schedule)}</div></div><span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${routine.running ? "bg-accent/15 text-accent" : routine.enabled ? "bg-success/15 text-success" : "bg-raised text-ink-secondary"}`}>{routine.running ? "Running" : routine.enabled ? "Enabled" : "Paused"}</span></div><p className="mt-2 line-clamp-2 text-[12.5px] leading-relaxed text-ink-secondary">{routine.prompt}</p><div className="mt-3 flex items-center justify-between"><span className="text-[11px] text-ink-secondary">Next {new Date(routine.nextRunAt).toLocaleString()}</span><div className="flex gap-1"><button aria-label={routine.enabled ? "Disable routine" : "Enable routine"} title={routine.enabled ? "Disable" : "Enable"} onClick={() => void mutate(routine, { enabled: !routine.enabled })} className="rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink">{routine.enabled ? <Pause size={15} /> : <Play size={15} />}</button><button aria-label="Delete routine" title="Delete" onClick={() => void remove(routine)} className="rounded-md p-1.5 text-ink-secondary hover:bg-danger/10 hover:text-danger"><Trash2 size={15} /></button></div></div>{routine.lastResult && <div className="mt-2 truncate text-[11px] text-ink-secondary">Last: {routine.lastResult}</div>}</div>;
      })}</div>
    </div>
  </aside>;
}
