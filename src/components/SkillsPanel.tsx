import { useEffect, useState } from "react";
import { BookOpen, Loader2, Trash2, X } from "lucide-react";
import { api, useStore, type Skill } from "@/state/store";
import { enabledSkillIds, toggleSkillId } from "@/lib/skills";
import { cn } from "@/lib/cn";

interface TeachSession {
  id: string;
  botId: string;
  status: "recording" | "completed";
  startedAt: number;
  stoppedAt?: number;
  name?: string;
  skillId?: string;
  events: unknown[];
  frames: unknown[];
}

export function SkillsPanel() {
  const { state, dispatch } = useStore();
  const [skills, setSkills] = useState<Skill[]>([]);
  const [sessions, setSessions] = useState<TeachSession[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);

  const reload = () => {
    api("/api/skills")
      .then(({ skills: list }) => setSkills(list ?? []))
      .catch((e) => setError(e.message));
    api("/api/teach-sessions")
      .then(({ sessions: list }) => setSessions(list ?? []))
      .catch(() => {});
  };

  useEffect(() => {
    reload();
  }, []);

  const save = async (skill: Skill, patch: Partial<Pick<Skill, "name" | "markdown">>) => {
    setSavingId(skill.id);
    setError(null);
    try {
      const { skill: saved } = await api(`/api/skills/${skill.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name: patch.name ?? skill.name, markdown: patch.markdown ?? skill.markdown, botId: skill.botId }),
      });
      setSkills((list) => list.map((item) => (item.id === saved.id ? saved : item)));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingId(null);
    }
  };

  const remove = async (skill: Skill) => {
    setError(null);
    try {
      await api(`/api/skills/${skill.id}`, { method: "DELETE" });
      setSkills((list) => list.filter((item) => item.id !== skill.id));
      for (const bot of state.bots) {
        const ids = enabledSkillIds(bot);
        if (!ids.includes(skill.id)) continue;
        dispatch({ type: "updateBot", botId: bot.id, patch: { enabledSkills: ids.filter((id) => id !== skill.id) } });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const toggleOnBot = (botId: string, skillId: string) => {
    const bot = state.bots.find((item) => item.id === botId);
    if (!bot) return;
    dispatch({ type: "updateBot", botId, patch: { enabledSkills: toggleSkillId(enabledSkillIds(bot), skillId) } });
  };

  return (
    <aside className="animate-panel-in flex h-full w-[420px] shrink-0 flex-col border-l border-hairline/40 bg-panel">
      <div className="flex items-center justify-between px-4 py-3">
        <BookOpen size={18} className="text-ink-secondary" />
        <span className="text-[15px] font-semibold text-ink">Skills</span>
        <button aria-label="Close skills" onClick={() => dispatch({ type: "toggleSkills", open: false })} className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink">
          <X size={18} />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-4 pb-4">
        <p className="text-[13px] leading-relaxed text-ink-secondary">
          Review taught skills and enable them on any bot. A bot can use more than one skill. Frames are counted, not replayed.
        </p>
        {error && <div className="mt-3 rounded-lg border border-danger/30 bg-danger/10 p-2 text-[12px] text-danger">{error}</div>}

        {sessions.length > 0 && (
          <div className="mt-4">
            <div className="mb-2 text-[12px] font-medium uppercase tracking-[0.08em] text-ink-secondary">Recordings</div>
            <div className="space-y-2">
              {sessions.map((session) => {
                const bot = state.bots.find((item) => item.id === session.botId);
                return (
                  <div key={session.id} className="rounded-xl bg-card p-3.5">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate text-[14px] font-medium text-ink">{session.name || "Teach session"}</div>
                        <div className="mt-0.5 text-[12px] text-ink-secondary">
                          {bot?.name ?? "Deleted bot"} · {session.events.length} events · {session.frames.length} frames
                        </div>
                      </div>
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${session.status === "recording" ? "bg-accent/15 text-accent" : "bg-success/15 text-success"}`}>
                        {session.status === "recording" ? "Recording" : "Saved"}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div className="mt-4">
          <div className="mb-2 text-[12px] font-medium uppercase tracking-[0.08em] text-ink-secondary">Library</div>
          {skills.length === 0 ? (
            <div className="rounded-xl border border-dashed border-hairline/50 p-6 text-center text-[13px] text-ink-secondary">
              No skills yet. Record a computer session from a bot&apos;s Computer panel.
            </div>
          ) : (
            <div className="space-y-2">
              {skills.map((skill) => {
                const bot = state.bots.find((item) => item.id === skill.botId);
                return (
                  <div key={skill.id} className="rounded-xl bg-card p-3.5">
                    <div className="flex items-start justify-between gap-3">
                      <input
                        value={skill.name}
                        onChange={(e) => setSkills((list) => list.map((item) => (item.id === skill.id ? { ...item, name: e.target.value } : item)))}
                        onBlur={() => void save(skill, { name: skill.name })}
                        className="min-w-0 flex-1 bg-transparent text-[14px] font-medium text-ink focus:outline-none"
                      />
                      {savingId === skill.id && <Loader2 size={14} className="animate-spin text-ink-secondary" />}
                      <button aria-label="Delete skill" title="Delete" onClick={() => void remove(skill)} className="rounded-md p-1.5 text-ink-secondary hover:bg-danger/10 hover:text-danger">
                        <Trash2 size={15} />
                      </button>
                    </div>
                    <div className="mt-0.5 text-[12px] text-ink-secondary">{bot?.name ?? "Deleted bot"}</div>
                    <textarea
                      value={skill.markdown}
                      onChange={(e) => setSkills((list) => list.map((item) => (item.id === skill.id ? { ...item, markdown: e.target.value } : item)))}
                      onBlur={() => void save(skill, { markdown: skill.markdown })}
                      rows={6}
                      className="mt-2 w-full resize-y rounded-lg border border-hairline/40 bg-inset px-3 py-2 font-mono text-[12px] text-ink"
                    />
                    <div className="mt-2">
                      <div className="text-[11px] text-ink-secondary">Enable on bots</div>
                      <div className="mt-1 overflow-hidden rounded-lg border border-hairline/40">
                        {state.bots.map((item, i) => {
                          const on = enabledSkillIds(item).includes(skill.id);
                          return (
                            <div
                              key={item.id}
                              className={cn("flex items-center justify-between gap-3 px-2 py-1.5", i > 0 && "border-t border-hairline/40")}
                            >
                              <span className="truncate text-[12px] text-ink">{item.name}</span>
                              <button
                                type="button"
                                role="switch"
                                aria-checked={on}
                                aria-label={`${on ? "Disable" : "Enable"} ${skill.name} on ${item.name}`}
                                onClick={() => toggleOnBot(item.id, skill.id)}
                                className={cn(
                                  "relative h-[20px] w-[34px] shrink-0 rounded-full transition-colors",
                                  on ? "bg-accent" : "bg-raised",
                                )}
                              >
                                <span
                                  className={cn(
                                    "absolute top-[2px] size-4 rounded-full bg-white transition-all",
                                    on ? "left-[14px]" : "left-[2px]",
                                  )}
                                />
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
