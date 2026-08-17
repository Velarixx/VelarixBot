import { useCallback, useEffect, useState, type FormEvent } from "react";
import { CalendarClock, FlaskConical, History, Loader2, Pause, Play, Plus, Trash2, X } from "lucide-react";
import { GITHUB_LISTENER_EVENTS, listenerScheduleFromForm, scheduleLabel, SLACK_LISTENER_MATCHES, type RoutineFormKind } from "@/lib/routines";
import { api, useStore, type GithubListenerEvent, type MissedPolicy, type Routine, type RoutineRun, type Skill, type SlackListenerMatch } from "@/state/store";

const MISSED_POLICY_LABELS: Array<[MissedPolicy, string]> = [
  ["run-once", "Run once (coalesce missed)"],
  ["skip", "Skip missed"],
  ["catch-up", "Catch up (run each missed)"],
];

const RUN_STATUS_STYLE: Record<RoutineRun["status"], string> = {
  running: "bg-accent/15 text-accent",
  done: "bg-success/15 text-success",
  blocked: "bg-danger/10 text-danger",
  skipped: "bg-raised text-ink-secondary",
  interrupted: "bg-danger/10 text-danger",
};

const KIND_TABS: Array<[RoutineFormKind, string]> = [
  ["interval", "Interval"],
  ["daily", "Daily"],
  ["github", "GitHub"],
  ["slack", "Slack"],
];

function RunHistory({ routine }: { routine: Routine }) {
  const [runs, setRuns] = useState<RoutineRun[] | null>(null);
  const refresh = useCallback(() => {
    api(`/api/routines/${routine.id}/runs`).then(({ runs: list }) => setRuns(list ?? [])).catch(() => setRuns([]));
  }, [routine.id]);
  useEffect(() => { refresh(); }, [refresh, routine.running, routine.lastResult, routine.nextRunAt]);
  if (runs === null) return <div className="mt-2 text-[11px] text-ink-secondary">Loading history…</div>;
  if (runs.length === 0) return <div className="mt-2 text-[11px] text-ink-secondary">No runs yet.</div>;
  return <ul className="mt-2 space-y-1.5">
    {runs.map((run) => <li key={run.seq} className="rounded-lg bg-inset px-2 py-1.5">
      <div className="flex items-center gap-2">
        <span className={`rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${RUN_STATUS_STYLE[run.status]}`}>{run.status}</span>
        {run.kind === "manual" && <span className="rounded-full bg-raised px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-ink-secondary">Test run</span>}
        {run.attempt > 1 && <span className="text-[10px] text-ink-secondary">attempt {run.attempt}</span>}
        <span className="ml-auto text-[10px] text-ink-secondary">{new Date(run.startedAt).toLocaleString()}</span>
      </div>
      {run.result && run.status !== "done" && <div className="mt-1 text-[11px] leading-snug text-ink-secondary">{run.result}</div>}
    </li>)}
  </ul>;
}

function EventChecks({ events, onChange }: { events: GithubListenerEvent[]; onChange: (events: GithubListenerEvent[]) => void }) {
  return <div className="mt-1 grid grid-cols-2 gap-1">
    {GITHUB_LISTENER_EVENTS.map(([value, label]) => {
      const on = events.includes(value);
      return <label key={value} className="flex items-center gap-1.5 text-[12px] text-ink">
        <input type="checkbox" checked={on} onChange={() => onChange(on ? events.filter((e) => e !== value) : [...events, value])} className="accent-accent" />
        {label}
      </label>;
    })}
  </div>;
}

function ListenerFields({
  kind,
  everyMinutes,
  setEveryMinutes,
  repoOwner,
  setRepoOwner,
  repoName,
  setRepoName,
  events,
  setEvents,
  channel,
  setChannel,
  match,
  setMatch,
  keyword,
  setKeyword,
}: {
  kind: RoutineFormKind;
  everyMinutes: number;
  setEveryMinutes: (n: number) => void;
  repoOwner: string;
  setRepoOwner: (v: string) => void;
  repoName: string;
  setRepoName: (v: string) => void;
  events: GithubListenerEvent[];
  setEvents: (v: GithubListenerEvent[]) => void;
  channel: string;
  setChannel: (v: string) => void;
  match: SlackListenerMatch | "";
  setMatch: (v: SlackListenerMatch | "") => void;
  keyword: string;
  setKeyword: (v: string) => void;
}) {
  return <>
    {kind === "github" ? <>
      <div className="grid grid-cols-2 gap-2">
        <label className="block text-[12px] text-ink-secondary">Owner<input required value={repoOwner} onChange={(e) => setRepoOwner(e.target.value)} placeholder="Velarixx" className="mt-1 w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[14px] text-ink" /></label>
        <label className="block text-[12px] text-ink-secondary">Repository<input required value={repoName} onChange={(e) => setRepoName(e.target.value)} placeholder="VelarixBot" className="mt-1 w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[14px] text-ink" /></label>
      </div>
      <div className="block text-[12px] text-ink-secondary">Events (pick at least one — no wildcard)<EventChecks events={events} onChange={setEvents} /></div>
    </> : <>
      <label className="block text-[12px] text-ink-secondary">Channel or DM<input required value={channel} onChange={(e) => setChannel(e.target.value)} placeholder="#eng or D0123 or @jane" className="mt-1 w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[14px] text-ink" /></label>
      <label className="block text-[12px] text-ink-secondary">Match<select required value={match} onChange={(e) => setMatch(e.target.value as SlackListenerMatch | "")} className="mt-1 w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[14px] text-ink"><option value="">Choose…</option>{SLACK_LISTENER_MATCHES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      {match === "keyword" ? <label className="block text-[12px] text-ink-secondary">Keyword<input required value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder="deploy" className="mt-1 w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[14px] text-ink" /></label> : null}
    </>}
    <label className="block text-[12px] text-ink-secondary">Poll every (minutes)<input type="number" min={1} value={everyMinutes} onChange={(e) => setEveryMinutes(Math.max(1, Number(e.target.value)))} className="mt-1 w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[14px] text-ink" /><span className="mt-1 block text-[11px] text-ink-secondary">Polls while VelarixBot is open. No matching event means no turn.</span></label>
  </>;
}

function RoutineCard({ routine, botName, skills, onPatch, onDelete, onError }: {
  routine: Routine;
  botName: string;
  skills: Skill[];
  onPatch: (routine: Routine, patch: Partial<Routine>) => Promise<void>;
  onDelete: (routine: Routine) => Promise<void>;
  onError: (message: string | null) => void;
}) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const [testing, setTesting] = useState(false);
  const [editing, setEditing] = useState(false);
  const schedule = routine.schedule;
  const [everyMinutes, setEveryMinutes] = useState(schedule.kind === "listener" ? (schedule.everyMinutes ?? 15) : 15);
  const [repoOwner, setRepoOwner] = useState(schedule.kind === "listener" && schedule.source === "github" ? (schedule.repo?.owner ?? "") : "");
  const [repoName, setRepoName] = useState(schedule.kind === "listener" && schedule.source === "github" ? (schedule.repo?.name ?? "") : "");
  const [events, setEvents] = useState<GithubListenerEvent[]>(schedule.kind === "listener" && schedule.source === "github" ? (schedule.events ?? []) : []);
  const [channel, setChannel] = useState(schedule.kind === "listener" && schedule.source === "slack" ? (schedule.channel ?? "") : "");
  const [match, setMatch] = useState<SlackListenerMatch | "">(schedule.kind === "listener" && schedule.source === "slack" ? (schedule.match ?? "") : "");
  const [keyword, setKeyword] = useState(schedule.kind === "listener" && schedule.source === "slack" ? (schedule.keyword ?? "") : "");
  const skill = skills.find((item) => item.id === routine.skillId);
  const listenerKind = schedule.kind === "listener" ? schedule.source : null;

  const testRun = async () => {
    setTesting(true); onError(null);
    try {
      await api(`/api/routines/${routine.id}/run`, { method: "POST" });
      setHistoryOpen(true);
    } catch (e) { onError(e instanceof Error ? e.message : String(e)); }
    finally { setTesting(false); }
  };

  const saveListener = async (event: FormEvent) => {
    event.preventDefault();
    if (!listenerKind) return;
    await onPatch(routine, {
      schedule: listenerScheduleFromForm({
        kind: listenerKind,
        everyMinutes,
        time: "09:00",
        repoOwner,
        repoName,
        events,
        channel,
        match,
        keyword,
      }),
    });
    setEditing(false);
  };

  return <div className="rounded-xl bg-card p-3.5">
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="truncate text-[14px] font-medium text-ink">{routine.name}</div>
        <div className="mt-0.5 text-[12px] text-ink-secondary">{botName} · {scheduleLabel(routine.schedule)}{skill ? ` · ${skill.name}` : ""}</div>
      </div>
      <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${routine.running ? "bg-accent/15 text-accent" : routine.enabled ? "bg-success/15 text-success" : "bg-raised text-ink-secondary"}`}>{routine.running ? "Running" : routine.enabled ? "Enabled" : "Paused"}</span>
    </div>
    <p className="mt-2 line-clamp-2 text-[12.5px] leading-relaxed text-ink-secondary">{routine.prompt}</p>
    <div className="mt-2 grid grid-cols-2 gap-2">
      <label className="block text-[11px] text-ink-secondary">If runs are missed<select value={routine.missedPolicy} onChange={(e) => void onPatch(routine, { missedPolicy: e.target.value as MissedPolicy })} className="mt-1 w-full rounded-lg border border-hairline/40 bg-inset px-2 py-1.5 text-[12px] text-ink">{MISSED_POLICY_LABELS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label className="block text-[11px] text-ink-secondary">Skill<select value={routine.skillId ?? ""} onChange={(e) => void onPatch(routine, { skillId: e.target.value || "" })} className="mt-1 w-full rounded-lg border border-hairline/40 bg-inset px-2 py-1.5 text-[12px] text-ink"><option value="">None</option>{skills.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
    </div>
    {listenerKind && editing ? <form onSubmit={(e) => void saveListener(e)} className="mt-3 space-y-2 rounded-lg bg-inset p-2.5">
      <ListenerFields kind={listenerKind} everyMinutes={everyMinutes} setEveryMinutes={setEveryMinutes} repoOwner={repoOwner} setRepoOwner={setRepoOwner} repoName={repoName} setRepoName={setRepoName} events={events} setEvents={setEvents} channel={channel} setChannel={setChannel} match={match} setMatch={setMatch} keyword={keyword} setKeyword={setKeyword} />
      <div className="flex justify-end gap-2"><button type="button" onClick={() => setEditing(false)} className="rounded-lg px-2 py-1 text-[12px] text-ink-secondary">Cancel</button><button className="rounded-lg bg-accent px-2 py-1 text-[12px] font-medium text-white">Save filter</button></div>
    </form> : listenerKind ? <button type="button" onClick={() => setEditing(true)} className="mt-2 text-[12px] text-accent hover:underline">Edit {listenerKind} filter</button> : null}
    <div className="mt-3 flex items-center justify-between">
      <span className="text-[11px] text-ink-secondary">Next {new Date(routine.nextRunAt).toLocaleString()}</span>
      <div className="flex gap-1">
        <button aria-label="Test run" title="Test run — runs now without touching the schedule" disabled={testing || routine.running} onClick={() => void testRun()} className="rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-40">{testing ? <Loader2 size={15} className="animate-spin" /> : <FlaskConical size={15} />}</button>
        <button aria-label={historyOpen ? "Hide run history" : "Show run history"} title="Run history" onClick={() => setHistoryOpen((open) => !open)} className={`rounded-md p-1.5 hover:bg-raised hover:text-ink ${historyOpen ? "bg-raised text-ink" : "text-ink-secondary"}`}><History size={15} /></button>
        <button aria-label={routine.enabled ? "Disable routine" : "Enable routine"} title={routine.enabled ? "Disable" : "Enable"} onClick={() => void onPatch(routine, { enabled: !routine.enabled })} className="rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink">{routine.enabled ? <Pause size={15} /> : <Play size={15} />}</button>
        <button aria-label="Delete routine" title="Delete" onClick={() => void onDelete(routine)} className="rounded-md p-1.5 text-ink-secondary hover:bg-danger/10 hover:text-danger"><Trash2 size={15} /></button>
      </div>
    </div>
    {routine.lastResult && <div className="mt-2 truncate text-[11px] text-ink-secondary">Last: {routine.lastResult}</div>}
    {historyOpen && <RunHistory routine={routine} />}
  </div>;
}

export function RoutinesPanel() {
  const { state, dispatch } = useStore();
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [botId, setBotId] = useState(state.selectedId || state.bots[0]?.id || "");
  const [kind, setKind] = useState<RoutineFormKind>("interval");
  const [everyMinutes, setEveryMinutes] = useState(60);
  const [time, setTime] = useState("09:00");
  const [repoOwner, setRepoOwner] = useState("");
  const [repoName, setRepoName] = useState("");
  const [events, setEvents] = useState<GithubListenerEvent[]>([]);
  const [channel, setChannel] = useState("");
  const [match, setMatch] = useState<SlackListenerMatch | "">("");
  const [keyword, setKeyword] = useState("");
  const [missedPolicy, setMissedPolicy] = useState<MissedPolicy>("run-once");
  const [thenBotId, setThenBotId] = useState("");
  const [thenPrompt, setThenPrompt] = useState("");
  const [skillId, setSkillId] = useState("");
  const [skills, setSkills] = useState<Skill[]>([]);
  const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  useEffect(() => {
    api("/api/routines").then(({ routines }) => dispatch({ type: "routinesLoaded", routines })).catch((e) => setError(e.message));
    api("/api/skills").then(({ skills: list }) => setSkills(list ?? [])).catch(() => {});
  }, [dispatch]);

  useEffect(() => {
    if (!state.routinesCreating) return;
    setCreating(true);
    if (state.routineCreateBotId) setBotId(state.routineCreateBotId);
  }, [state.routinesCreating, state.routineCreateBotId]);

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
    if (kind === "github" && !events.length) { setError("Pick at least one GitHub event."); return; }
    const schedule = listenerScheduleFromForm({
      kind,
      everyMinutes: kind === "daily" ? 60 : everyMinutes,
      time,
      timeZone: browserZone,
      repoOwner,
      repoName,
      events,
      channel,
      match,
      keyword,
    });
    setSaving(true); setError(null);
    try {
      const { routine } = await api("/api/routines", {
        method: "POST",
        body: JSON.stringify({
          botId,
          name: name.trim(),
          prompt: prompt.trim(),
          schedule,
          missedPolicy,
          ...(thenBotId && thenPrompt.trim() ? { thenStartTurn: { botId: thenBotId, prompt: thenPrompt.trim() } } : {}),
          ...(skillId ? { skillId } : {}),
        }),
      });
      dispatch({ type: "routineSaved", routine });
      setName(""); setPrompt(""); setThenBotId(""); setThenPrompt(""); setSkillId(""); setMissedPolicy("run-once");
      setRepoOwner(""); setRepoName(""); setEvents([]); setChannel(""); setMatch(""); setKeyword("");
      setKind("interval"); setCreating(false);
      dispatch({ type: "toggleRoutines", open: true });
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
      <p className="text-[13px] leading-relaxed text-ink-secondary">Schedule a prompt for a bot. Routines persist locally and run while VelarixBot is open — they do not run when the app is closed. Each routine's missed-run policy decides what happens to runs that came due while it was. GitHub and Slack listeners poll while the app is open; they fire only on a new matching event.</p>
      {error && <div className="mt-3 rounded-lg border border-danger/30 bg-danger/10 p-2 text-[12px] text-danger">{error}</div>}
      {creating ? <form onSubmit={create} className="mt-4 space-y-3 rounded-xl bg-card p-4">
        <label className="block text-[12px] text-ink-secondary">Bot<select value={botId} onChange={(e) => setBotId(e.target.value)} className="mt-1 w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[14px] text-ink">{state.bots.map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}</select></label>
        <label className="block text-[12px] text-ink-secondary">Name<input autoFocus required value={name} onChange={(e) => setName(e.target.value)} placeholder="Morning briefing" className="mt-1 w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[14px] text-ink" /></label>
        <label className="block text-[12px] text-ink-secondary">Prompt<textarea required rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Summarize today's priorities…" className="mt-1 w-full resize-none rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[14px] text-ink" /></label>
        <div className="flex overflow-hidden rounded-lg border border-hairline/40">
          {KIND_TABS.map(([value, label], i) => (
            <button key={value} type="button" onClick={() => setKind(value)} className={`flex-1 py-1.5 text-[12px] ${i > 0 ? "border-l border-hairline/40" : ""} ${kind === value ? "bg-raised text-ink" : "text-ink-secondary hover:bg-raised/60 hover:text-ink"}`}>{label}</button>
          ))}
        </div>
        {kind === "daily" ? (
          <label className="block text-[12px] text-ink-secondary">Time<input type="time" required value={time} onChange={(e) => setTime(e.target.value)} className="mt-1 w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[14px] text-ink" /><span className="mt-1 block text-[11px] text-ink-secondary">In your time zone ({browserZone}) — daylight saving handled automatically.</span></label>
        ) : kind === "interval" ? (
          <label className="block text-[12px] text-ink-secondary">Run every (minutes)<input type="number" min={1} value={everyMinutes} onChange={(e) => setEveryMinutes(Math.max(1, Number(e.target.value)))} className="mt-1 w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[14px] text-ink" /></label>
        ) : (
          <ListenerFields kind={kind} everyMinutes={everyMinutes} setEveryMinutes={setEveryMinutes} repoOwner={repoOwner} setRepoOwner={setRepoOwner} repoName={repoName} setRepoName={setRepoName} events={events} setEvents={setEvents} channel={channel} setChannel={setChannel} match={match} setMatch={setMatch} keyword={keyword} setKeyword={setKeyword} />
        )}
        <label className="block text-[12px] text-ink-secondary">If runs are missed while VelarixBot is closed<select value={missedPolicy} onChange={(e) => setMissedPolicy(e.target.value as MissedPolicy)} className="mt-1 w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[14px] text-ink">{MISSED_POLICY_LABELS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label className="block text-[12px] text-ink-secondary">Then also start a turn on (optional)<select value={thenBotId} onChange={(e) => setThenBotId(e.target.value)} className="mt-1 w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[14px] text-ink"><option value="">None</option>{state.bots.map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}</select></label>
        {thenBotId ? <label className="block text-[12px] text-ink-secondary">Prompt<textarea required rows={3} value={thenPrompt} onChange={(e) => setThenPrompt(e.target.value)} placeholder="Follow up on that result…" className="mt-1 w-full resize-none rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[14px] text-ink" /></label> : null}
        <label className="block text-[12px] text-ink-secondary">Taught skill (optional)<select value={skillId} onChange={(e) => setSkillId(e.target.value)} className="mt-1 w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[14px] text-ink"><option value="">None</option>{skills.map((skill) => <option key={skill.id} value={skill.id}>{skill.name}</option>)}</select></label>
        <div className="flex justify-end gap-2"><button type="button" onClick={() => { setCreating(false); dispatch({ type: "toggleRoutines", open: true }); }} className="rounded-lg px-3 py-2 text-[13px] text-ink-secondary">Cancel</button><button disabled={saving} className="flex items-center gap-2 rounded-lg bg-accent px-3 py-2 text-[13px] font-medium text-white disabled:opacity-50">{saving && <Loader2 size={13} className="animate-spin" />}Create</button></div>
      </form> : <button onClick={() => setCreating(true)} className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg bg-accent py-2.5 text-[14px] font-medium text-white"><Plus size={16} />New routine</button>}
      <div className="mt-4 space-y-2">{state.routines.length === 0 && !creating ? <div className="rounded-xl border border-dashed border-hairline/50 p-6 text-center text-[13px] text-ink-secondary">No routines yet.</div> : state.routines.map((routine) => (
        <RoutineCard key={routine.id} routine={routine} botName={state.bots.find((item) => item.id === routine.botId)?.name ?? "Deleted bot"} skills={skills} onPatch={mutate} onDelete={remove} onError={setError} />
      ))}</div>
    </div>
  </aside>;
}
