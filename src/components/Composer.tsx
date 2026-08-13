import { useEffect, useMemo, useRef, useState } from "react";
import { Plus, Mic, Square, Paperclip, X } from "lucide-react";
import { useStore, type Bot } from "@/state/store";
import { cn } from "@/lib/cn";
import { MausAvatar } from "./Avatar";
import { normalizeState } from "@/lib/mascot";
import { chipFromDroppedFile, sendPayload, type AttachmentChip } from "@/lib/attachments";
import {
  filterSlashCommands,
  moveHighlight,
  slashQueryAt,
  type SlashHit,
} from "@/lib/slash-commands";

/** The active @mention query at the caret: the text between an `@` that
 * starts a word and the caret. null = no mention being typed. */
function mentionQueryAt(text: string, caret: number): { start: number; query: string } | null {
  const upto = text.slice(0, caret);
  const at = upto.lastIndexOf("@");
  if (at === -1) return null;
  if (at > 0 && !/\s/.test(upto[at - 1])) return null; // user@host, not a tag
  const query = upto.slice(at + 1);
  if (query.length > 24 || query.includes("@") || query.includes("\n")) return null;
  return { start: at, query };
}

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
  const chipSeq = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  // what was typed before the mic went on — partials append after it
  const baseText = useRef("");

  const queued = state.queued[bot.id] ?? [];

  // ── slash-command menu (typing `/` at a word start) ──
  const slash = slashQueryAt(text, caret);
  const slashHits = useMemo(() => {
    if (!slash || slash.start === dismissedAt) return [];
    return filterSlashCommands(slash.query, { busy: Boolean(bot.busy) });
  }, [slash, dismissedAt, bot.busy]);
  const slashOpen = slashHits.length > 0;

  // ── @mention picker (tag another bot; the agent reaches it via ask_bot) ──
  const mention = mentionQueryAt(text, caret);
  const candidates = useMemo(() => {
    if (slashOpen || !mention || mention.start === dismissedAt) return [];
    const peers = state.bots.filter((b) => b.id !== bot.id && !b.hidden);
    const q = mention.query.trim().toLowerCase();
    // "@Scout " — the full name plus a space — is a COMPLETED tag, not a
    // search: keep the picker closed so Enter sends instead of re-picking
    if (mention.query.endsWith(" ") && peers.some((b) => b.name.toLowerCase() === q)) return [];
    return peers.filter((b) => !q || b.name.toLowerCase().includes(q)).slice(0, 6);
  }, [slashOpen, mention, dismissedAt, state.bots, bot.id]);
  const pickerOpen = candidates.length > 0;

  useEffect(() => setHighlight(0), [slash?.start, slash?.query, mention?.start, mention?.query]);

  const pickMention = (peer: Bot) => {
    if (!mention) return;
    const after = text.slice(caret);
    const next = `${text.slice(0, mention.start)}@${peer.name} ${after}`;
    setText(next);
    const newCaret = mention.start + peer.name.length + 2;
    setCaret(newCaret);
    // picking completes this tag — close the popup so the next Enter sends
    setDismissedAt(mention.start);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(newCaret, newCaret);
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
    if (!payload.text && !payload.attachments.length) return;
    dispatch({ type: "send", botId: bot.id, text: payload.text, attachments: payload.attachments });
    setText("");
    setChips([]);
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

  const runSlash = (hit: SlashHit) => {
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
            {slashHits.map((hit, i) => (
              <button
                key={hit.command.id}
                type="button"
                disabled={!hit.enabled}
                onClick={() => runSlash(hit)}
                onMouseEnter={() => setHighlight(i)}
                className={cn(
                  "flex w-full flex-col gap-0.5 px-3 py-2 text-left",
                  i === highlight ? "bg-raised-hover" : "",
                  hit.enabled ? "text-ink" : "cursor-not-allowed text-ink-secondary/50",
                )}
              >
                <span className="text-[14px] font-medium">/{hit.command.name}</span>
                <span className="text-[12px] text-ink-secondary">{hit.command.description}</span>
              </button>
            ))}
          </div>
        )}
        {pickerOpen && (
          <div className="absolute bottom-full left-10 z-20 mb-2 w-72 overflow-hidden rounded-xl border border-hairline/40 bg-raised shadow-lg">
            {candidates.map((peer, i) => (
              <button
                key={peer.id}
                onClick={() => pickMention(peer)}
                onMouseEnter={() => setHighlight(i)}
                className={cn(
                  "flex w-full items-center gap-2.5 px-3 py-2 text-left",
                  i === highlight ? "bg-raised-hover" : "",
                )}
              >
                <MausAvatar color={peer.color} iconShape={peer.iconShape} state={normalizeState(peer.mascotExpression) ?? "happy"} size={24} />
                <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-ink">{peer.name}</span>
                <span className="shrink-0 text-xs text-ink-secondary">Agent</span>
              </button>
            ))}
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
        {chips.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-2 pt-1">
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
                setHighlight((h) => moveHighlight(h, delta, slashHits.length));
                return;
              }
              if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                runSlash(slashHits[highlight] ?? slashHits[0]);
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
