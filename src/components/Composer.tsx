import { useEffect, useMemo, useRef, useState } from "react";
import { Plus, Mic, Square, Paperclip, X } from "lucide-react";
import { api, useStore, type Bot, type Skill } from "@/state/store";
import { cn } from "@/lib/cn";
import { BotFace } from "./Avatar";
import { normalizeState } from "@/lib/mascot";
import { chipFromDroppedFile, sendPayload, type AttachmentChip } from "@/lib/attachments";
import { enabledSkillIds } from "@/lib/skills";
import {
  filterMentionCandidates,
  insertMention,
  mentionableBots,
  mentionableRoutines,
  mentionQueryAt,
  routineSendFromText,
  type MentionCandidate,
} from "@/lib/mentions";
import {
  moveHighlight,
  slashMenuItems,
  slashQueryAt,
  type SlashMenuItem,
} from "@/lib/slash-commands";

export function Composer({ bot }: { bot: Bot }) {
  const { state, dispatch } = useStore();
  const [text, setText] = useState("");
  const [recording, setRecording] = useState(false);
  const [speechError, setSpeechError] = useState<string | null>(null);
  const showMic = !window.ogb || window.ogb.platform === "darwin";
  const [caret, setCaret] = useState(0);
  const [highlight, setHighlight] = useState(0);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null); // Esc'd this @
  const [chips, setChips] = useState<AttachmentChip[]>([]);
  const [skillChips, setSkillChips] = useState<Array<{ id: string; name: string }>>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const chipSeq = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  // what was typed before the mic went on — partials append after it
  const baseText = useRef("");

  const queued = state.queued[bot.id] ?? [];

  useEffect(() => {
    api("/api/skills")
      .then(({ skills: list }) => setSkills(list ?? []))
      .catch(() => {});
  }, []);

  const enabledSkills = useMemo(() => {
    const ids = new Set(enabledSkillIds(bot));
    return skills.filter((skill) => ids.has(skill.id));
  }, [skills, bot]);

  // ── slash-command menu (typing `/` at a word start) ──
  const slash = slashQueryAt(text, caret);
  const slashItems = useMemo(() => {
    if (!slash || slash.start === dismissedAt) return [];
    return slashMenuItems(
      slash.query,
      { busy: Boolean(bot.busy) },
      enabledSkills.map((skill) => ({ id: skill.id, name: skill.name })),
    );
  }, [slash, dismissedAt, bot.busy, enabledSkills]);
  const slashOpen = slashItems.length > 0;

  // ── @mention picker (bots via ask_bot; routines via startRun) ──
  const mention = mentionQueryAt(text, caret);
  const candidates = useMemo(() => {
    if (slashOpen || !mention || mention.start === dismissedAt) return [];
    return filterMentionCandidates(
      mention.query,
      mentionableBots(state.bots, bot.id),
      mentionableRoutines(state.routines, state.bots),
    );
  }, [slashOpen, mention, dismissedAt, state.bots, state.routines, bot.id]);
  const pickerOpen = candidates.length > 0;

  useEffect(() => setHighlight(0), [slash?.start, slash?.query, mention?.start, mention?.query]);

  const pickMention = (candidate: MentionCandidate) => {
    if (!mention) return;
    const next = insertMention(text, caret, mention, candidate.name);
    setText(next.text);
    setCaret(next.caret);
    setDismissedAt(mention.start);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(next.caret, next.caret);
    });
  };

  const addFiles = (files: Array<{ name: string; path?: string; type?: string }>) => {
    setChips((current) => {
      const next = [...current];
      for (const file of files) {
        const chip = chipFromDroppedFile(file, `att-${chipSeq.current++}`);
        if (!chip) continue;
        if (next.some((c) => c.path === chip.path)) continue;
        next.push(chip);
      }
      return next;
    });
  };

  const send = () => {
    const payload = sendPayload(text, chips);
    const mentionSkills = skillChips.map((chip) => chip.id);
    const routineSend = routineSendFromText(payload.text, state.routines, state.bots);
    if (routineSend) {
      void api(`/api/routines/${routineSend.routineId}/run`, {
        method: "POST",
        body: JSON.stringify(routineSend.prompt ? { prompt: routineSend.prompt } : {}),
      }).catch(() => {});
      setText("");
      setChips([]);
      setSkillChips([]);
      return;
    }
    if (!payload.text && !payload.attachments.length && !mentionSkills.length) return;
    dispatch({
      type: "send",
      botId: bot.id,
      text: payload.text || (mentionSkills.length ? "Follow the mentioned skill." : ""),
      attachments: payload.attachments,
      mentionSkillIds: mentionSkills,
    });
    setText("");
    setChips([]);
    setSkillChips([]);
  };

  // native dictation: partials stream into the input while the Swift
  // helper runs; the final transcript stays in the box, ready to edit/send
  useEffect(() => {
    if (!recording) return;
    const bridge = window.ogb;
    if (!bridge) {
      setRecording(false);
      return;
    }
    setSpeechError(null);
    const offTranscript = bridge.onSpeechTranscript((line) => {
      if (typeof line.text === "string") {
        const base = baseText.current;
        setText(base ? `${base} ${line.text}` : line.text);
      }
    });
    const offEnd = bridge.onSpeechEnd(({ code }) => {
      setRecording(false);
      if (code === 1) {
        setSpeechError(
          "Dictation needs Microphone + Speech Recognition access — System Settings → Privacy & Security.",
        );
      }
    });
    void bridge.speechStart();
    return () => {
      offTranscript();
      offEnd();
      void bridge.speechStop();
    };
  }, [recording]);

  const toggleMic = () => {
    if (!window.ogb) {
      setSpeechError("Voice input needs the desktop app — run pnpm dev:desktop.");
      return;
    }
    baseText.current = text.trim();
    setRecording((r) => !r);
  };

  const onDropFiles = (list: FileList | null) => {
    if (!list?.length) return;
    addFiles(
      [...list].map((file) => ({
        name: file.name,
        path: (file as File & { path?: string }).path,
        type: file.type,
      })),
    );
  };

  const pickFiles = () => {
    if (window.ogb?.openFiles) {
      void window.ogb.openFiles().then((files) => addFiles(files ?? []));
      return;
    }
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.onchange = () =>
      onDropFiles(input.files);
    input.click();
  };

  const pickSlashSkill = (skill: { id: string; name: string }) => {
    setSkillChips((current) => (current.some((chip) => chip.id === skill.id) ? current : [...current, skill]));
    if (slash) {
      const after = text.slice(caret);
      const next = `${text.slice(0, slash.start)}${after}`.replace(/^\s+/, "");
      setText(next);
      setCaret(0);
    } else {
      setText("");
      setCaret(0);
    }
    setDismissedAt(null);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const runSlash = (item: SlashMenuItem) => {
    if (item.kind === "skill") {
      pickSlashSkill(item.hit.skill);
      return;
    }
    const hit = item.hit;
    if (!hit.enabled) return;
    if (hit.command.id === "help") {
      setText("/");
      setCaret(1);
      setDismissedAt(null);
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.setSelectionRange(1, 1);
      });
      return;
    }
    setText("");
    setCaret(0);
    setDismissedAt(null);
    switch (hit.command.id) {
      case "newBot":
        dispatch({ type: "newBot" });
        break;
      case "model":
        dispatch({ type: "toggleSettings", open: true });
        break;
      case "computer":
        dispatch({ type: "toggleComputer", open: true });
        break;
      case "attach":
        pickFiles();
        break;
      case "stop":
        dispatch({ type: "interrupt", botId: bot.id });
        break;
    }
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  return (
    <div className="px-5 pb-5 pt-2">
      {speechError && (
        <div className="mx-auto mb-2 max-w-[900px] rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-[12px] text-warning">
          {speechError}
        </div>
      )}
      <div className="relative mx-auto max-w-[900px]">
        {queued.length > 0 && (
          <div className="mb-2 flex flex-col gap-1.5">
            {queued.map((item, i) => (
              <div
                key={item.id}
                className="flex items-center gap-2 rounded-xl border border-dashed border-hairline/50 bg-raised/40 px-3 py-2"
              >
                <span className="shrink-0 rounded bg-inset px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-ink-secondary">
                  Queued {i + 1}
                </span>
                <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{item.text || "Attachment"}</span>
                <button
                  type="button"
                  onClick={() => dispatch({ type: "cancelQueued", botId: bot.id, id: item.id })}
                  className="rounded-full p-0.5 text-ink-secondary hover:bg-raised hover:text-ink"
                  title="Cancel queued prompt"
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
        {slashOpen && (
          <div
            data-slash-menu
            className="absolute bottom-full left-10 z-20 mb-2 w-80 overflow-hidden rounded-xl border border-hairline/40 bg-raised shadow-lg"
          >
            {slashItems.map((item, i) =>
              item.kind === "command" ? (
                <button
                  key={item.hit.command.id}
                  type="button"
                  disabled={!item.hit.enabled}
                  onClick={() => runSlash(item)}
                  onMouseEnter={() => setHighlight(i)}
                  className={cn(
                    "flex w-full flex-col gap-0.5 px-3 py-2 text-left",
                    i === highlight ? "bg-raised-hover" : "",
                    item.hit.enabled ? "text-ink" : "cursor-not-allowed text-ink-secondary/50",
                  )}
                >
                  <span className="text-[14px] font-medium">/{item.hit.command.name}</span>
                  <span className="text-[12px] text-ink-secondary">{item.hit.command.description}</span>
                </button>
              ) : (
                <button
                  key={`skill-${item.hit.skill.id}`}
                  type="button"
                  onClick={() => runSlash(item)}
                  onMouseEnter={() => setHighlight(i)}
                  className={cn(
                    "flex w-full items-center justify-between gap-2 px-3 py-2 text-left",
                    i === highlight ? "bg-raised-hover" : "",
                  )}
                >
                  <span className="min-w-0 truncate text-[14px] font-medium text-ink">/{item.hit.skill.name}</span>
                  <span className="shrink-0 text-xs text-ink-secondary">This turn</span>
                </button>
              ),
            )}
          </div>
        )}
        {pickerOpen && (
          <div className="absolute bottom-full left-10 z-20 mb-2 w-72 overflow-hidden rounded-xl border border-hairline/40 bg-raised shadow-lg">
            {candidates.map((candidate, i) => {
              const peer = candidate.kind === "bot" ? state.bots.find((b) => b.id === candidate.id) : null;
              return (
                <button
                  key={`${candidate.kind}-${candidate.id}`}
                  onClick={() => pickMention(candidate)}
                  onMouseEnter={() => setHighlight(i)}
                  className={cn(
                    "flex w-full items-center gap-2.5 px-3 py-2 text-left",
                    i === highlight ? "bg-raised-hover" : "",
                  )}
                >
                  {peer ? (
                    <BotFace bot={peer} state={normalizeState(peer.mascotExpression) ?? "happy"} size={24} />
                  ) : (
                    <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-inset text-[10px] font-semibold text-ink-secondary">
                      R
                    </span>
                  )}
                  <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-ink">{candidate.name}</span>
                  <span className="shrink-0 text-xs text-ink-secondary">{candidate.kind === "routine" ? "Routine" : "Agent"}</span>
                </button>
              );
            })}
          </div>
        )}
        <div
          className="flex flex-col gap-2 rounded-[22px] border border-hairline/40 bg-raised/60 py-2 pl-2 pr-2"
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
          }}
          onDrop={(e) => {
            e.preventDefault();
            onDropFiles(e.dataTransfer.files);
          }}
        >
        {(chips.length > 0 || skillChips.length > 0) && (
          <div className="flex flex-wrap gap-1.5 px-2 pt-1">
            {skillChips.map((chip) => (
              <span
                key={`skill-${chip.id}`}
                className="flex max-w-full items-center gap-1.5 rounded-full bg-accent/15 px-2.5 py-1 text-[12px] text-ink"
              >
                <span className="truncate">/{chip.name}</span>
                <span className="text-[10px] uppercase tracking-wide text-ink-secondary">This turn</span>
                <button
                  type="button"
                  onClick={() => setSkillChips((c) => c.filter((item) => item.id !== chip.id))}
                  className="rounded-full p-0.5 text-ink-secondary hover:bg-raised hover:text-ink"
                  title="Remove this-turn skill"
                >
                  <X size={12} />
                </button>
              </span>
            ))}
            {chips.map((chip) => (
              <span
                key={chip.id}
                className="flex max-w-full items-center gap-1.5 rounded-full bg-card px-2.5 py-1 text-[12px] text-ink"
              >
                <span className="truncate">{chip.name}</span>
                <button
                  type="button"
                  onClick={() => setChips((c) => c.filter((item) => item.id !== chip.id))}
                  className="rounded-full p-0.5 text-ink-secondary hover:bg-raised hover:text-ink"
                  title="Remove attachment"
                >
                  <X size={12} />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="flex items-center gap-2">
        <button
          onClick={() => dispatch({ type: "newBot" })}
          className="flex size-8 shrink-0 items-center justify-center rounded-full text-ink-secondary hover:bg-raised hover:text-ink"
          title="New bot"
        >
          <Plus size={20} />
        </button>
        <button
          onClick={pickFiles}
          className="flex size-8 shrink-0 items-center justify-center rounded-full text-ink-secondary hover:bg-raised hover:text-ink"
          title="Attach files"
        >
          <Paperclip size={16} />
        </button>
        <input
          ref={inputRef}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setCaret(e.target.selectionStart ?? e.target.value.length);
            setDismissedAt(null);
          }}
          onPaste={(e) => {
            if (e.clipboardData?.files?.length) onDropFiles(e.clipboardData.files);
          }}
          onKeyUp={(e) => setCaret((e.target as HTMLInputElement).selectionStart ?? 0)}
          onClick={(e) => setCaret((e.target as HTMLInputElement).selectionStart ?? 0)}
          onKeyDown={(e) => {
            if (slashOpen) {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                const delta = e.key === "ArrowDown" ? 1 : -1;
                setHighlight((h) => moveHighlight(h, delta, slashItems.length));
                return;
              }
              if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                runSlash(slashItems[highlight] ?? slashItems[0]);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setDismissedAt(slash?.start ?? null);
                return;
              }
            }
            if (pickerOpen) {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                const delta = e.key === "ArrowDown" ? 1 : -1;
                setHighlight((h) => moveHighlight(h, delta, candidates.length));
                return;
              }
              if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                pickMention(candidates[highlight]);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setDismissedAt(mention?.start ?? null);
                return;
              }
            }
            if (e.key === "Enter") send();
            if (e.key === "Escape" && recording) setRecording(false);
          }}
          placeholder={
            recording ? "Listening…" : bot.busy ? `Queue a follow-up for ${bot.name}` : `Message ${bot.name}`
          }
          className="w-full bg-transparent text-[15px] text-ink placeholder:text-ink-secondary focus:outline-none"
        />
        {bot.busy ? (
          <button
            onClick={() => dispatch({ type: "interrupt", botId: bot.id })}
            className="flex size-8 shrink-0 items-center justify-center rounded-full text-ink-secondary hover:bg-raised hover:text-ink"
            title="Stop"
          >
            <Square size={14} className="fill-current" />
          </button>
        ) : showMic && (
          <button
            onClick={toggleMic}
            className={cn(
              "flex size-8 shrink-0 items-center justify-center rounded-full",
              recording
                ? "animate-pulse bg-danger/20 text-danger"
                : "text-ink-secondary hover:bg-raised hover:text-ink",
            )}
            title={recording ? "Stop dictation (Esc)" : "Dictate"}
          >
            <Mic size={18} />
          </button>
        )}
        </div>
        </div>
      </div>
    </div>
  );
}
