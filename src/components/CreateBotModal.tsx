import { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import {
  api,
  postNewBot,
  useStore,
  type Bot,
  type ModelSelection,
  type NewBotInit,
} from "@/state/store";
import { BotFace } from "./Avatar";
import { MAUS_COLOR_NAMES, MAUS_COLORS, stateForBot, type MausColor } from "@/lib/mascot";
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

function draftBot(over: {
  name: string;
  title: string;
  description: string;
  color: MausColor;
  modelSelection: ModelSelection;
  created?: Bot | null;
}): Bot {
  if (over.created) return { ...over.created, name: over.name, title: over.title, description: over.description, color: over.color, modelSelection: over.modelSelection };
  return {
    id: "draft",
    threadId: "",
    name: over.name,
    title: over.title,
    description: over.description,
    notifications: true,
    color: over.color,
    unread: false,
    busy: false,
    state: "IDLE",
    usage: { input: 0, output: 0, cost: null },
    modelSelection: over.modelSelection,
    messages: [],
  };
}

function emptySelection(instances: { instanceId: string; models: { default: string } }[]): ModelSelection {
  const first = instances[0];
  return first ? { instanceId: first.instanceId, model: first.models.default } : { instanceId: "", model: "" };
}

// [VERIFY] 2026-08-18: one create modal. Sidebar Plus, Composer Plus, /new,
// and empty-state "Create a bot" open this. Confirm POSTs /api/bots with
// { name } plus title/description/color/model when set. Generate portraits
// is imageReady-only and uses POST /api/bots/:id/avatar/generate after the
// named create (seed/hash need a bot id). Settings-only bindings stay off
// this form so PATCH 409s are not bypassed.
export function CreateBotModal() {
  const { state, dispatch } = useStore();
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [color, setColor] = useState<MausColor>("green");
  const [modelSelection, setModelSelection] = useState<ModelSelection>(() => emptySelection(state.instances));
  const [created, setCreated] = useState<Bot | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [candidates, setCandidates] = useState<string[]>([]);
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);

  const imageReady = Boolean(
    state.config?.xai?.configured || state.config?.openai?.configured || state.config?.openrouter?.configured,
  );

  useEffect(() => {
    setModelSelection((current) => (current.instanceId ? current : emptySelection(state.instances)));
  }, [state.instances]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") dispatch({ type: "toggleCreateBot", open: false });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dispatch]);

  const payload: NewBotInit = useMemo(() => {
    const init: NewBotInit = { name: name.trim(), color };
    const trimmedTitle = title.trim();
    const trimmedDescription = description.trim();
    if (trimmedTitle) init.title = trimmedTitle;
    if (trimmedDescription) init.description = trimmedDescription;
    if (modelSelection.model) init.model = modelSelection.model;
    return init;
  }, [name, title, description, color, modelSelection.model]);

  const preview = draftBot({ name, title, description, color, modelSelection, created });

  const close = () => dispatch({ type: "toggleCreateBot", open: false });

  const ensureCreated = async (): Promise<Bot> => {
    if (created) return created;
    const { bot } = await postNewBot(payload);
    dispatch({ type: "botAdded", bot });
    setCreated(bot);
    return bot;
  };

  const confirm = () => {
    if (!payload.name || submitting) return;
    if (created) {
      close();
      return;
    }
    setSubmitting(true);
    dispatch({ type: "newBot", ...payload });
  };

  const generatePortraits = () => {
    if (!imageReady || !payload.name || generating || submitting) return;
    setGenerating(true);
    setGenerateError(null);
    void ensureCreated()
      .then((bot) => api(`/api/bots/${bot.id}/avatar/generate`, { method: "POST", body: JSON.stringify({}) }))
      .then((r) => {
        const hashes = (r.candidates ?? []).map((c: { hash: string }) => c.hash);
        setCandidates(hashes);
        if (r.bot) {
          setCreated((prev) => (prev ? { ...prev, ...r.bot } : r.bot));
          dispatch({ type: "botPatched", bot: r.bot });
        }
      })
      .catch((e) => setGenerateError(e instanceof Error ? e.message : String(e)))
      .finally(() => setGenerating(false));
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-bot-title"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="flex max-h-[90vh] w-full max-w-[420px] flex-col overflow-hidden rounded-2xl border border-hairline/40 bg-panel shadow-2xl">
        <div className="flex items-center justify-between px-5 py-3">
          <h2 id="create-bot-title" className="text-[15px] font-semibold text-ink">
            Create a bot
          </h2>
          <button
            type="button"
            onClick={close}
            className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 pb-5">
          <div className="flex justify-center py-3">
            <BotFace bot={preview} state={stateForBot(preview)} size={96} />
          </div>

          {imageReady && (
            <div className="mb-4">
              <div className="mb-2 text-[12px] font-medium uppercase tracking-[0.08em] text-ink-secondary">
                Portrait
              </div>
              <div className="mb-3 text-[12px] text-ink-secondary">
                Generate four portraits from this bot's name and personality, then pick one. The seeded mascot stays the
                fallback.
              </div>
              <button
                type="button"
                disabled={!payload.name || generating || submitting}
                onClick={generatePortraits}
                className="rounded-md bg-raised px-3 py-1.5 text-[13px] text-ink hover:bg-raised-hover disabled:cursor-not-allowed disabled:opacity-40"
              >
                {generating ? "Generating…" : candidates.length ? "Regenerate" : "Generate portraits"}
              </button>
              {generateError && <div className="mt-2 text-[12px] text-danger">{generateError}</div>}
              {candidates.length > 0 && created && (
                <div className="mt-3 grid grid-cols-4 gap-2">
                  {candidates.map((hash) => (
                    <button
                      key={hash}
                      type="button"
                      onClick={() => {
                        api(`/api/bots/${created.id}`, {
                          method: "PATCH",
                          body: JSON.stringify({ avatarImageHash: hash }),
                        })
                          .then(({ bot: next }) => {
                            setCreated(next);
                            dispatch({ type: "botPatched", bot: next });
                          })
                          .catch(() => {});
                      }}
                      className={cn(
                        "flex aspect-square items-center justify-center overflow-hidden rounded-xl bg-inset transition-colors hover:bg-raised",
                        created.avatarImageHash === hash && "ring-2 ring-accent-border",
                      )}
                      title="Use this portrait"
                      aria-label="Use this portrait"
                    >
                      <img src={`/api/bots/${created.id}/avatar/${hash}`} alt="" className="size-full object-cover" />
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="mb-2 text-[12px] font-medium uppercase tracking-[0.08em] text-ink-secondary">Color</div>
          <div className="mb-4 flex flex-wrap gap-2.5">
            {MAUS_COLOR_NAMES.map((next) => (
              <button
                key={next}
                type="button"
                onClick={() => setColor(next)}
                className={cn(
                  "size-8 rounded-full border-2 border-transparent transition-transform hover:scale-110",
                  color === next && "ring-2 ring-accent-border ring-offset-2 ring-offset-card",
                )}
                style={{ backgroundColor: MAUS_COLORS[next] }}
                title={next}
                aria-label={`Use ${next} mascot color`}
              />
            ))}
          </div>

          <div className="flex flex-col gap-4">
            <Field label="Name">
              <input
                className={inputCls}
                value={name}
                autoFocus
                disabled={Boolean(created)}
                onChange={(e) => setName(e.target.value)}
                placeholder="Scout"
              />
            </Field>
            <Field label="Title">
              <input
                className={inputCls}
                placeholder="Describe what your agent does"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </Field>
            <Field label="Description">
              <textarea
                className={cn(inputCls, "min-h-[96px] resize-none")}
                placeholder="What this agent is for"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </Field>

            <div className="flex items-center justify-between gap-4 rounded-xl bg-card p-4">
              <div>
                <div className="text-[15px] font-medium text-ink">Model</div>
                <div className="mt-0.5 text-[13px] text-ink-secondary">Which provider and model this bot runs on</div>
              </div>
              <ModelPicker bot={preview} onSelect={created ? undefined : setModelSelection} />
            </div>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-hairline/40 px-5 py-3">
          <button
            type="button"
            onClick={close}
            className="rounded-lg px-3 py-2 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink"
          >
            Cancel
          </button>
          <button
            type="button"
            data-create-bot-confirm
            disabled={!payload.name || submitting || generating}
            onClick={confirm}
            className="rounded-lg bg-accent px-4 py-2 text-[13px] font-medium text-white hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Create
          </button>
        </div>
      </div>
    </div>
  );
}
