import { useEffect, useState } from "react";
import { ChevronLeft, Trash2, X } from "lucide-react";
import { api, useStore, type Bot, type Skill } from "@/state/store";
import { CONNECTOR_PATHS, enabledAppSlugs, toggleEnabledApp } from "@/lib/apps";
import { enabledSkillIds, toggleSkillId } from "@/lib/skills";
import { BotFace, MausAvatar } from "./Avatar";
import {
  PICKABLE_STATES,
  stateForBot,
  MAUS_COLORS,
  MAUS_COLOR_NAMES,
} from "@/lib/mascot";
import { ICON_SHAPE_NAMES } from "@/lib/mascot-shapes";
import { NOTIFY_EVENTS, NOTIFY_EVENT_LABELS, type NotifyEventType } from "@/lib/notify";
import { localComputerSupported } from "@/lib/local-computer";
import { ModelPicker } from "./ModelPicker";
import { cn } from "@/lib/cn";

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <div className="mb-1.5 text-[13px] text-ink-secondary">{label}</div>
      {children}
    </label>
  );
}

const inputCls =
  "w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2.5 text-[15px] text-ink placeholder:text-ink-secondary focus:outline-none focus:border-hairline";

export function SettingsPanel({ bot }: { bot: Bot }) {
  const { state, dispatch } = useStore();
  const patch = (
    p: Partial<
      Pick<Bot, "name" | "title" | "description" | "notifications" | "notifyEvents" | "computer" | "color" | "mascotExpression" | "mascotPinned" | "iconShape" | "avatarNonce" | "avatarImageHash" | "requireApproval" | "alwaysAllow" | "enabledApps" | "enabledSkills" | "skillId">
    >,
  ) => dispatch({ type: "updateBot", botId: bot.id, patch: p });
  // Zero-key seeded re-roll: bump the persisted nonce and let the server
  // derive the face (seedAvatar(botId, nonce)) — the PATCH response carries
  // the derived color/shape/expression, so the preview updates immediately
  // and the exact same face regenerates on every future load. Keeping the
  // face is just… not re-rolling: it's already persisted.
  const rerollFace = () => {
    api(`/api/bots/${bot.id}`, {
      method: "PATCH",
      body: JSON.stringify({ avatarNonce: (bot.avatarNonce ?? 0) + 1 }),
    })
      .then(({ bot: next }) => dispatch({ type: "botPatched", bot: next }))
      .catch(() => {});
  };
  const activeState = stateForBot(bot);
  const mascotMotion = state.mascotMotion?.botId === bot.id ? state.mascotMotion : null;
  const [apps, setApps] = useState<Array<{ slug: string; label: string }>>([]);
  const [rules, setRules] = useState<
    Array<{ id: string; tool: string; pattern: string; action: "allow" | "deny"; disabled?: boolean; quarantined?: boolean }>
  >([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [memory, setMemory] = useState({ user: "", distilled: "", workspace: "" });
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [candidates, setCandidates] = useState<string[]>(bot.avatarCandidates ?? []);
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const lastBot = state.bots.length <= 1;
  const imageReady = Boolean(
    state.config?.xai?.configured || state.config?.openai?.configured || state.config?.openrouter?.configured,
  );

  useEffect(() => {
    setCandidates(bot.avatarCandidates ?? []);
    setGenerateError(null);
  }, [bot.id, bot.avatarCandidates]);

  useEffect(() => {
    let alive = true;
    api("/api/skills")
      .then((r) => {
        if (!alive) return;
        setSkills(r.skills ?? []);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    api(CONNECTOR_PATHS.catalog)
      .then((r) => {
        if (!alive) return;
        setApps((r.cards ?? []).map((c: { slug: string; label: string }) => ({ slug: c.slug, label: c.label })));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    api(`/api/bots/${bot.id}/approvals`)
      .then((r) => {
        if (!alive) return;
        setRules(r.rules ?? []);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [bot.id]);

  useEffect(() => {
    let alive = true;
    api(`/api/bots/${bot.id}/memory`)
      .then((r) => {
        if (!alive) return;
        setMemory({
          user: typeof r.user === "string" ? r.user : "",
          distilled: typeof r.distilled === "string" ? r.distilled : "",
          workspace: typeof r.workspace === "string" ? r.workspace : "",
        });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [bot.id]);

  useEffect(() => {
    setConfirmDelete(false);
  }, [bot.id]);

  const toggleApp = (slug: string) => {
    patch({ enabledApps: toggleEnabledApp(enabledAppSlugs(bot), slug) });
  };

  const openAppsHub = () => {
    dispatch({ type: "toggleSettings", open: false });
    dispatch({ type: "togglePlugins", open: true });
  };

  const toggleSkill = (skillId: string) => {
    patch({ enabledSkills: toggleSkillId(enabledSkillIds(bot), skillId) });
  };

  const persistMemory = (next: { user: string; distilled: string; workspace: string }) => {
    setMemory(next);
    void api(`/api/bots/${bot.id}/memory`, {
      method: "PUT",
      body: JSON.stringify(next),
    }).catch(() => {});
  };

  return (
    <aside className="animate-panel-in flex h-full w-[400px] shrink-0 flex-col border-l border-hairline/40 bg-panel">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3">
        <button
          onClick={() => dispatch({ type: "toggleSettings", open: false })}
          className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink"
        >
          <ChevronLeft size={18} />
        </button>
        <span className="text-[15px] font-semibold text-ink">Settings</span>
        <button
          onClick={() => dispatch({ type: "toggleSettings", open: false })}
          className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink"
        >
          <X size={18} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-5 pb-5">
        <div className="flex justify-center py-5">
          <BotFace
            bot={bot}
            state={activeState}
            size={112}
            motion={mascotMotion?.kind ?? "none"}
            motionKey={mascotMotion?.nonce ?? 0}
          />
        </div>

        <div className="flex flex-col gap-4">
          <div className="overflow-hidden rounded-xl border border-hairline/40 bg-card">
            <div className="flex items-center justify-between border-b border-hairline/40 px-3 py-2.5">
              <span className="rounded-lg bg-raised px-3 py-1.5 text-[14px] font-medium text-ink">
                Bot
              </span>
              <div className="flex items-center gap-1">
                <button
                  onClick={rerollFace}
                  title="Roll a new seeded face (color, shape, expression). It saves instantly — keep it by leaving it."
                  aria-label="Re-roll face"
                  className="rounded-md px-2 py-1.5 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink"
                >
                  Re-roll
                </button>
                <button
                  onClick={() => patch({ color: "green", mascotExpression: null, mascotPinned: false, iconShape: "cursor" })}
                  className="rounded-md px-2 py-1.5 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink"
                >
                  Reset
                </button>
              </div>
            </div>

            <div className="p-3">
              <div className="mb-2 text-[12px] font-medium uppercase tracking-[0.08em] text-ink-secondary">
                Portrait
              </div>
              <div className="mb-3 text-[12px] text-ink-secondary">
                {imageReady
                  ? "Generate four portraits from this bot's name and personality, then pick one. The seeded mascot stays the fallback."
                  : "Add an xAI, OpenAI, or OpenRouter key in App Settings to generate portraits. The seeded mascot works without keys."}
              </div>
              <div className="mb-4 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={!imageReady || generating}
                  onClick={() => {
                    setGenerating(true);
                    setGenerateError(null);
                    api(`/api/bots/${bot.id}/avatar/generate`, { method: "POST", body: JSON.stringify({}) })
                      .then((r) => {
                        const hashes = (r.candidates ?? []).map((c: { hash: string }) => c.hash);
                        setCandidates(hashes);
                        if (r.bot) dispatch({ type: "botPatched", bot: r.bot });
                      })
                      .catch((e) => setGenerateError(e instanceof Error ? e.message : String(e)))
                      .finally(() => setGenerating(false));
                  }}
                  className="rounded-md bg-raised px-3 py-1.5 text-[13px] text-ink hover:bg-raised-hover disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {generating ? "Generating…" : candidates.length ? "Regenerate" : "Generate portraits"}
                </button>
                {bot.avatarImageHash && (
                  <button
                    type="button"
                    onClick={() => {
                      api(`/api/bots/${bot.id}`, {
                        method: "PATCH",
                        body: JSON.stringify({ avatarImageHash: null }),
                      })
                        .then(({ bot: next }) => dispatch({ type: "botPatched", bot: next }))
                        .catch(() => {});
                    }}
                    className="rounded-md px-2 py-1.5 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink"
                  >
                    Use vector
                  </button>
                )}
              </div>
              {generateError && <div className="mb-3 text-[12px] text-danger">{generateError}</div>}
              {candidates.length > 0 && (
                <div className="mb-4 grid grid-cols-4 gap-2">
                  {candidates.map((hash) => (
                    <button
                      key={hash}
                      type="button"
                      onClick={() => {
                        api(`/api/bots/${bot.id}`, {
                          method: "PATCH",
                          body: JSON.stringify({ avatarImageHash: hash }),
                        })
                          .then(({ bot: next }) => dispatch({ type: "botPatched", bot: next }))
                          .catch(() => {});
                      }}
                      className={cn(
                        "flex aspect-square items-center justify-center overflow-hidden rounded-xl bg-inset transition-colors hover:bg-raised",
                        bot.avatarImageHash === hash && "ring-2 ring-accent-border",
                      )}
                      title="Use this portrait"
                      aria-label="Use this portrait"
                    >
                      <img
                        src={`/api/bots/${bot.id}/avatar/${hash}`}
                        alt=""
                        className="size-full object-cover"
                      />
                    </button>
                  ))}
                </div>
              )}

              <div className="mb-2 text-[12px] font-medium uppercase tracking-[0.08em] text-ink-secondary">
                Expression
              </div>
              <div className="grid grid-cols-5 gap-2">
                {PICKABLE_STATES.map((expression) => (
                  <button
                    key={expression}
                    onClick={() => patch({ mascotExpression: expression, mascotPinned: true })}
                    className={cn(
                      "flex h-[58px] items-center justify-center rounded-xl bg-inset transition-colors hover:bg-raised",
                      activeState === expression && "ring-2 ring-accent-border",
                    )}
                    title={expression}
                    aria-label={`Use ${expression} expression`}
                  >
                    <MausAvatar color={bot.color} state={expression} iconShape={bot.iconShape} size={42} animated={false} />
                  </button>
                ))}
              </div>

              <div className="mb-2 mt-4 text-[12px] font-medium uppercase tracking-[0.08em] text-ink-secondary">
                Shape
              </div>
              <div className="grid grid-cols-4 gap-2">
                {ICON_SHAPE_NAMES.map((shape) => (
                  <button
                    key={shape}
                    onClick={() => patch({ iconShape: shape })}
                    className={cn(
                      "flex h-[58px] flex-col items-center justify-center rounded-xl bg-inset transition-colors hover:bg-raised",
                      (bot.iconShape ?? "cursor") === shape && "ring-2 ring-accent-border",
                    )}
                    title={shape}
                    aria-label={`Use ${shape} icon`}
                  >
                    <MausAvatar color={bot.color} state={activeState} iconShape={shape} size={36} animated={false} />
                  </button>
                ))}
              </div>

              <div className="mb-2 mt-4 text-[12px] font-medium uppercase tracking-[0.08em] text-ink-secondary">
                Color
              </div>
              <div className="flex flex-wrap gap-2.5">
                {MAUS_COLOR_NAMES.map((color) => (
                  <button
                    key={color}
                    onClick={() => patch({ color })}
                    className={cn(
                      "size-8 rounded-full border-2 border-transparent transition-transform hover:scale-110",
                      bot.color === color && "ring-2 ring-accent-border ring-offset-2 ring-offset-card",
                    )}
                    style={{ backgroundColor: MAUS_COLORS[color] }}
                    title={color}
                    aria-label={`Use ${color} mascot color`}
                  />
                ))}
              </div>
            </div>
          </div>

          <Field label="Name">
            <input
              className={inputCls}
              value={bot.name}
              onChange={(e) => patch({ name: e.target.value })}
            />
          </Field>
          <Field label="Title">
            <input
              className={inputCls}
              placeholder="Describe what your agent does"
              value={bot.title}
              onChange={(e) => patch({ title: e.target.value })}
            />
          </Field>
          <Field label="Description">
            <textarea
              className={cn(inputCls, "min-h-[96px] resize-none")}
              placeholder="What this agent is for"
              value={bot.description}
              onChange={(e) => patch({ description: e.target.value })}
            />
          </Field>

          <div className="rounded-xl bg-card p-4">
            <div className="text-[15px] font-medium text-ink">Skills this bot may use</div>
            <div className="mt-0.5 text-[13px] text-ink-secondary">
              Skills are a workspace library. Only toggled skills are injected on every turn for this bot.
            </div>
            {skills.length === 0 ? (
              <div className="mt-3 text-[12px] text-ink-secondary">No skills yet — teach one from a computer session or save a recipe.</div>
            ) : (
              <div className="mt-3 max-h-56 overflow-y-auto rounded-lg border border-hairline/40">
                {skills.map((skill, i) => {
                  const on = enabledSkillIds(bot).includes(skill.id);
                  return (
                    <div
                      key={skill.id}
                      className={cn("flex items-center justify-between gap-3 px-3 py-2", i > 0 && "border-t border-hairline/40")}
                    >
                      <span className="truncate text-[13px] text-ink">{skill.name}</span>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={on}
                        aria-label={`${on ? "Disable" : "Enable"} ${skill.name}`}
                        onClick={() => toggleSkill(skill.id)}
                        className={cn(
                          "relative h-[22px] w-[38px] shrink-0 rounded-full transition-colors",
                          on ? "bg-accent" : "bg-raised",
                        )}
                      >
                        <span
                          className={cn(
                            "absolute top-[3px] size-4 rounded-full bg-white transition-all",
                            on ? "left-[17px]" : "left-[3px]",
                          )}
                        />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="rounded-xl bg-card p-4">
            <div className="text-[15px] font-medium text-ink">Memory</div>
            <div className="mt-0.5 text-[13px] text-ink-secondary">
              Local notes for this bot. Distilled notes update after a turn. Workspace notes are shared with every bot. Nothing leaves this machine.
            </div>
            <div className="mt-3">
              <Field label="This bot">
                <textarea
                  className={cn(inputCls, "min-h-[72px] resize-y")}
                  placeholder="Facts and preferences to keep"
                  value={memory.user}
                  onChange={(e) => setMemory((m) => ({ ...m, user: e.target.value }))}
                  onBlur={(e) => persistMemory({ ...memory, user: e.target.value })}
                />
              </Field>
            </div>
            <div className="mt-3">
              <Field label="Distilled">
                <textarea
                  className={cn(inputCls, "min-h-[72px] resize-y font-mono text-[13px]")}
                  placeholder="Updated automatically after turns"
                  value={memory.distilled}
                  onChange={(e) => setMemory((m) => ({ ...m, distilled: e.target.value }))}
                  onBlur={(e) => persistMemory({ ...memory, distilled: e.target.value })}
                />
              </Field>
            </div>
            <div className="mt-3">
              <Field label="Shared workspace">
                <textarea
                  className={cn(inputCls, "min-h-[72px] resize-y")}
                  placeholder="Notes every bot should see"
                  value={memory.workspace}
                  onChange={(e) => setMemory((m) => ({ ...m, workspace: e.target.value }))}
                  onBlur={(e) => persistMemory({ ...memory, workspace: e.target.value })}
                />
              </Field>
            </div>
          </div>

          <div className="flex items-center justify-between gap-4 rounded-xl bg-card p-4">
            <div>
              <div className="text-[15px] font-medium text-ink">Model</div>
              <div className="mt-0.5 text-[13px] text-ink-secondary">
                Which provider and model this bot runs on
              </div>
            </div>
            <ModelPicker bot={bot} />
          </div>

          <div className="rounded-xl bg-card p-4">
            <div className="text-[15px] font-medium text-ink">Computer</div>
            <div className="mt-0.5 text-[13px] text-ink-secondary">
              Where this bot's computer runs{bot.computer ? "" : " (currently: auto)"}
            </div>
            <div className="mt-3 flex overflow-hidden rounded-lg border border-hairline/40">
              {/* "cloud" is the legacy alias the server resolves to the
                  configured remote provider binding (the bundled "box") */}
              {(localComputerSupported(window.ogb?.platform)
                ? (["cloud", "local", "off"] as const)
                : (["cloud", "off"] as const)
              ).map((mode, i) => (
                <button
                  key={mode}
                  onClick={() => patch({ computer: mode })}
                  className={cn(
                    "flex-1 py-1.5 text-[13px] capitalize",
                    i > 0 && "border-l border-hairline/40",
                    (mode === "cloud"
                      ? Boolean(bot.computer) && bot.computer !== "local" && bot.computer !== "off"
                      : bot.computer === mode)
                      ? "bg-raised text-ink"
                      : "text-ink-secondary hover:bg-raised/60 hover:text-ink",
                  )}
                >
                  {mode}
                </button>
              ))}
            </div>
          </div>

          <div className="rounded-xl bg-card p-4">
            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="text-[15px] font-medium text-ink">
                  Notifications
                </div>
                <div className="mt-0.5 text-[13px] text-ink-secondary">
                  Choose which events toast for this bot
                </div>
              </div>
              <button
                role="switch"
                aria-checked={bot.notifications}
                onClick={() => patch({ notifications: !bot.notifications })}
                className={cn(
                  "relative h-[26px] w-[44px] shrink-0 rounded-full transition-colors",
                  bot.notifications ? "bg-accent" : "bg-raised",
                )}
              >
                <span
                  className={cn(
                    "absolute top-[3px] size-5 rounded-full bg-white transition-all",
                    bot.notifications ? "left-[21px]" : "left-[3px]",
                  )}
                />
              </button>
            </div>
            {bot.notifications && (
              <div className="mt-3 overflow-hidden rounded-lg border border-hairline/40">
                {NOTIFY_EVENTS.map((type: NotifyEventType, i) => {
                  const enabled = bot.notifyEvents?.[type] !== false;
                  const copy = NOTIFY_EVENT_LABELS[type];
                  return (
                    <div
                      key={type}
                      className={cn("flex items-center justify-between gap-3 px-3 py-2", i > 0 && "border-t border-hairline/40")}
                    >
                      <div className="min-w-0">
                        <div className="truncate text-[13px] text-ink">{copy.title}</div>
                        <div className="truncate text-[12px] text-ink-secondary">{copy.hint}</div>
                      </div>
                      <button
                        role="switch"
                        aria-checked={enabled}
                        aria-label={`${enabled ? "Disable" : "Enable"} ${copy.title}`}
                        onClick={() =>
                          patch({
                            notifyEvents: { ...bot.notifyEvents, [type]: !enabled },
                          })
                        }
                        className={cn(
                          "relative h-[22px] w-[38px] shrink-0 rounded-full transition-colors",
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
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="flex items-center justify-between gap-4 rounded-xl bg-card p-4">
            <div>
              <div className="text-[15px] font-medium text-ink">Always allow</div>
              <div className="mt-0.5 text-[13px] text-ink-secondary">
                Let this bot do routine reads, writes, tool calls, and connected-app actions without
                asking. Only this bot — never workspace-wide. Sign-in and credential requests still ask
                you, and Require approval below overrides this.
              </div>
            </div>
            <button
              role="switch"
              aria-label="Always allow"
              aria-checked={bot.alwaysAllow === true}
              onClick={() => patch({ alwaysAllow: !bot.alwaysAllow })}
              className={cn(
                "relative h-[26px] w-[44px] shrink-0 rounded-full transition-colors",
                bot.alwaysAllow ? "bg-accent" : "bg-raised",
              )}
            >
              <span
                className={cn(
                  "absolute top-[3px] size-5 rounded-full bg-white transition-all",
                  bot.alwaysAllow ? "left-[21px]" : "left-[3px]",
                )}
              />
            </button>
          </div>

          <div className="flex items-center justify-between gap-4 rounded-xl bg-card p-4">
            <div>
              <div className="text-[15px] font-medium text-ink">Require approval</div>
              <div className="mt-0.5 text-[13px] text-ink-secondary">
                Always show a permission card, even when a stored Allow, Always allow, or full auto would skip it
              </div>
            </div>
            <button
              role="switch"
              aria-label="Require approval"
              aria-checked={bot.requireApproval === true}
              onClick={() => patch({ requireApproval: !bot.requireApproval })}
              className={cn(
                "relative h-[26px] w-[44px] shrink-0 rounded-full transition-colors",
                bot.requireApproval ? "bg-accent" : "bg-raised",
              )}
            >
              <span
                className={cn(
                  "absolute top-[3px] size-5 rounded-full bg-white transition-all",
                  bot.requireApproval ? "left-[21px]" : "left-[3px]",
                )}
              />
            </button>
          </div>

          <div className="rounded-xl bg-card p-4">
            <div className="text-[15px] font-medium text-ink">Approval rules</div>
            <div className="mt-0.5 text-[13px] text-ink-secondary">
              Always-allow rules are scoped to one bot unless you explicitly chose all bots. Revoke a rule to ask
              again. Paused legacy rules stay off until you re-enable them. Patterns never store raw secrets.
            </div>
            {rules.length === 0 ? (
              <div className="mt-3 text-[12px] text-ink-secondary">
                No rules yet — choose Always allow for this bot on a permission card to add one.
              </div>
            ) : (
              <div className="mt-3 max-h-56 overflow-y-auto rounded-lg border border-hairline/40">
                {rules.map((rule, i) => (
                  <div
                    key={rule.id}
                    className={cn("flex items-start justify-between gap-3 px-3 py-2", i > 0 && "border-t border-hairline/40")}
                  >
                    <div className="min-w-0">
                      <div className="truncate text-[13px] text-ink">
                        {rule.tool}
                        <span className="ml-2 text-[11px] uppercase tracking-wide text-ink-secondary">{rule.action}</span>
                        {rule.quarantined && (
                          <span className="ml-2 text-[11px] uppercase tracking-wide text-danger">paused</span>
                        )}
                      </div>
                      <div className="truncate font-mono text-[11px] text-ink-secondary">{rule.pattern || "*"}</div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      {rule.quarantined && (
                        <button
                          type="button"
                          aria-label={`Re-enable ${rule.tool} ${rule.action} rule`}
                          title="This legacy rule was paused for reconfirmation — re-enable it"
                          onClick={() => {
                            api(`/api/bots/${bot.id}/approvals/${rule.id}`, {
                              method: "PATCH",
                              body: JSON.stringify({ confirmed: true }),
                            })
                              .then(({ rule: confirmed }) =>
                                setRules((list) => list.map((r) => (r.id === rule.id ? confirmed : r))),
                              )
                              .catch(() => {});
                          }}
                          className="rounded-md px-2 py-1 text-[12px] text-ink-secondary hover:bg-raised hover:text-ink"
                        >
                          Re-enable
                        </button>
                      )}
                      <button
                        type="button"
                        aria-label={`Revoke ${rule.tool} ${rule.action} rule`}
                        title="Revoke"
                        onClick={() => {
                          api(`/api/bots/${bot.id}/approvals/${rule.id}`, { method: "DELETE" })
                            .then(() => setRules((list) => list.filter((r) => r.id !== rule.id)))
                            .catch(() => {});
                        }}
                        className="rounded-md p-1.5 text-ink-secondary hover:bg-danger/10 hover:text-danger"
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="rounded-xl bg-card p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-[15px] font-medium text-ink">Apps this bot may use</div>
                <div className="mt-0.5 text-[13px] text-ink-secondary">
                  Connected apps stay workspace-wide. Only toggled apps are mounted as tools for this bot.
                </div>
              </div>
              <button
                type="button"
                onClick={openAppsHub}
                className="shrink-0 rounded-md px-2 py-1.5 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink"
              >
                Open Apps
              </button>
            </div>
            {apps.length === 0 ? (
              <div className="mt-3 text-[12px] text-ink-secondary">
                No catalog yet — open Apps to connect through Composio.
              </div>
            ) : (
              <div className="mt-3 max-h-56 overflow-y-auto rounded-lg border border-hairline/40">
                {apps.map((app, i) => {
                  const on = enabledAppSlugs(bot).includes(app.slug);
                  return (
                    <div
                      key={app.slug}
                      className={cn("flex items-center justify-between gap-3 px-3 py-2", i > 0 && "border-t border-hairline/40")}
                    >
                      <span className="truncate text-[13px] text-ink">{app.label}</span>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={on}
                        aria-label={`${on ? "Disable" : "Enable"} ${app.label}`}
                        onClick={() => toggleApp(app.slug)}
                        className={cn(
                          "relative h-[22px] w-[38px] shrink-0 rounded-full transition-colors",
                          on ? "bg-accent" : "bg-raised",
                        )}
                      >
                        <span
                          className={cn(
                            "absolute top-[3px] size-4 rounded-full bg-white transition-all",
                            on ? "left-[17px]" : "left-[3px]",
                          )}
                        />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="rounded-xl bg-card p-4">
            <div className="text-[15px] font-medium text-ink">Remove bot</div>
            <div className="mt-0.5 text-[13px] text-ink-secondary">
              {lastBot
                ? "This is the last bot in the workspace — add another before removing it."
                : "Deletes this bot, its transcript, and its workspace files."}
            </div>
            {lastBot ? null : confirmDelete ? (
              <div className="mt-3 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    dispatch({ type: "deleteBot", botId: bot.id });
                    dispatch({ type: "toggleSettings", open: false });
                  }}
                  className="rounded-lg bg-danger/15 px-3 py-2 text-[13px] font-medium text-danger hover:bg-danger/25"
                >
                  Confirm remove
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmDelete(false)}
                  className="rounded-lg px-3 py-2 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                className="mt-3 rounded-lg px-3 py-2 text-[13px] font-medium text-danger hover:bg-danger/10"
              >
                Remove bot
              </button>
            )}
          </div>
        </div>
      </div>
    </aside>
  );
}
