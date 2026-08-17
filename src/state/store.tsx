// Server-backed store. The React app holds no transports of its own:
// it dispatches typed commands over HTTP and folds the one SSE event
// stream from the harness server into local state. The reducer stays
// pure; everything async lives in the wrapped dispatch + SSE fold.
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from "react";
import type { MausColor, MausMotion } from "@/lib/mascot";
import type { BotState, Usage } from "@/lib/product";
import { appendStreamingResponseText } from "../../server/response-options";
import { notifyCopy, unreadBotCount, type NotifyEventType } from "@/lib/notify";
import {
  cancelPrompt,
  enqueuePrompt,
  nextFlushBotIds,
  shouldEnqueueSend,
  takeNext,
  type QueuedPrompt,
} from "@/lib/prompt-queue";
import { advanceCursor, eventsUrl, INITIAL_CURSOR, shouldApplyFrame, type SseCursor } from "@/lib/sse-resume";

export type { QueuedPrompt };

export type { MausColor } from "@/lib/mascot";

export interface OptionCardData {
  title: string;
  subtitle: string;
  options: string[];
  answered?: string;
  dismissed?: boolean;
  /** Present when this card is a live provider ask (approval/question/sign-in). */
  requestId?: string;
  requestType?: "permission" | "question" | "credential" | "secret" | "suggestion";
  /** Composio OAuth URL for connect_app — opened in the user's browser. */
  connectUrl?: string;
  /** PRO extract card. Accept writes via the card PATCH, never a new turn. */
  suggestion?: { botId: string; type: "preference" | "fact" | "workflow"; text: string };
}

export interface Message {
  id: string;
  role: "bot" | "user";
  kind: "text" | "options" | "activity" | "screen";
  text?: string;
  card?: OptionCardData;
  /** activity messages: tool name + outcome */
  tool?: { name: string; ok?: boolean };
  /** screen messages: a frame of the bot's computer (base64) */
  png?: string;
  mime?: string;
  at: number;
}

export interface ModelSelection {
  instanceId: string;
  model: string;
}

export interface Bot {
  id: string;
  threadId: string;
  name: string;
  title: string;
  description: string;
  notifications: boolean;
  /** Per-event overrides; missing keys default on when notifications is on. */
  notifyEvents?: Partial<Record<NotifyEventType, boolean>>;
  color: MausColor;
  mascotExpression?: string | null;
  /** True only for an explicit Settings-grid pick; false when the stored
   * expression was derived by the A1 seed (re-roll). See stateForBot. */
  mascotPinned?: boolean;
  iconShape?: string | null;
  /** Seeded avatar re-roll counter; the server derives the face from
   * seedAvatar({ botId, nonce }) whenever this is patched. */
  avatarNonce?: number;
  /** A2 accepted raster — sha256 in the blob store. Missing = vector mascot. */
  avatarImageHash?: string | null;
  /** Last generate batch (hashes only). */
  avatarCandidates?: string[];
  unread: boolean;
  busy?: boolean;
  state: BotState;
  stateDetail?: string;
  usage: Usage;
  currentTurnUsage?: Usage;
  modelSelection: ModelSelection;
  /** Computer provider BINDING: "off", "local", or a provider id like "box"
   * (the server accepts the legacy "cloud" alias and stores the binding).
   * Unset = auto (remote computer if one exists, else local). */
  computer?: string;
  /** Force a permission card even when the provider is in full-auto. */
  requireApproval?: boolean;
  /** Permissions → Always allow: routine asks auto-resolve for THIS bot
   * only. Credential/sign-in asks still card; requireApproval wins. */
  alwaysAllow?: boolean;
  /** Connected-app slugs this bot may use. Empty/missing = none. */
  enabledApps?: string[];
  /** Taught skills this bot injects on every turn (library enable set). */
  enabledSkills?: string[];
  /** Legacy single attach. Empty enabledSkills + skillId set → [skillId]. */
  skillId?: string;
  /** Other bots sharing this transcript (group mention / ask_bot). */
  threadParticipants?: string[];
  pinned?: boolean;
  hidden?: boolean;
  messages: Message[];
}

/** GET /api/config — configured flags only; secrets are never echoed. */
export interface ConfigStatus {
  xai?: { configured: boolean };
  composio: { configured: boolean; apiKeyConfigured?: boolean };
  box: { configured: boolean };
  github?: { configured: boolean };
  openai?: { configured: boolean };
  openrouter?: { configured: boolean };
  omnirouter?: { configured: boolean };
}

export type RoutineSchedule =
  | { kind: "interval"; everyMinutes: number }
  | { kind: "daily"; time: string; timeZone?: string }
  | { kind: "weekdays"; time: string; timeZone?: string }
  | { kind: "listener"; source: "github" | "slack"; everyMinutes?: number };
export type MissedPolicy = "skip" | "run-once" | "catch-up";
export interface RoutineRun {
  seq: number; startedAt: number; finishedAt: number | null; scheduledFor: number | null;
  kind: "scheduled" | "manual"; status: "running" | "done" | "blocked" | "skipped" | "interrupted";
  attempt: number; result: string | null;
}
export interface Routine {
  id: string; botId: string; name: string; prompt: string; schedule: RoutineSchedule;
  enabled: boolean; running: boolean; nextRunAt: number; lastRunAt: number | null;
  lastResult: string | null; createdAt: number; missedPolicy: MissedPolicy;
  thenStartTurn?: { botId: string; prompt: string };
  skillId?: string;
}

export interface Skill {
  id: string;
  name: string;
  botId: string;
  markdown: string;
  createdAt: number;
}

/** One row of GET /api/instances — the model picker's data. */
export interface InstanceInfo {
  instanceId: string;
  driverKind: string;
  displayName: string;
  snapshot: {
    state: "available" | "unavailable";
    reason?: string;
    authenticated?: boolean;
    version?: string | null;
  };
  models: { default: string; options: Array<{ id: string; label: string }> };
}

interface AppState {
  bots: Bot[];
  instances: InstanceInfo[];
  config: ConfigStatus | null;
  selectedId: string;
  settingsOpen: boolean;
  pluginsOpen: boolean;
  computerOpen: boolean;
  appSettingsOpen: boolean;
  routinesOpen: boolean;
  skillsOpen: boolean;
  routinesCreating: boolean;
  routineCreateBotId: string | null;
  routines: Routine[];
  /** in-flight assistant text per threadId (content.delta fold) */
  streaming: Record<string, string>;
  /** Unfiltered in-flight text retained while the visible projection hides
   * the machine-readable response-option trailer. */
  streamingRaw: Record<string, string>;
  /** latest live frame of a bot's computer, per botId */
  screens: Record<string, { png: string; mime: string }>;
  /** bots whose cloud computer is being provisioned */
  provisioning: Record<string, boolean>;
  connected: boolean;
  error: string | null;
  mascotMotion: {
    botId: string;
    nonce: number;
    kind: Exclude<MausMotion, "none">;
  } | null;
  /** Composer follow-ups waiting for the current turn to finish, per bot. */
  queued: Record<string, QueuedPrompt[]>;
}

type Action =
  | { type: "hydrate"; bots: Bot[] }
  | { type: "instances"; instances: InstanceInfo[] }
  | { type: "configStatus"; config: ConfigStatus }
  | { type: "select"; id: string }
  | { type: "send"; botId: string; text: string; attachments?: Array<{ path: string; mime?: string }>; mentionSkillIds?: string[] }
  | { type: "enqueue"; botId: string; item: QueuedPrompt }
  | { type: "cancelQueued"; botId: string; id: string }
  | { type: "flushQueue"; botId: string }
  | {
      type: "answerCard";
      botId: string;
      messageId: string;
      answer: string;
      /** Explicit persistence consent — plain Allow never persists a rule. */
      always?: boolean;
      /** Rule scope when always is set; defaults to this bot on the server. */
      persistScope?: "bot" | "workspace";
      secret?: string;
    }
  | { type: "dismissCard"; botId: string; messageId: string }
  | { type: "newBot" }
  | { type: "botAdded"; bot: Bot; select?: boolean }
  | { type: "deleteBot"; botId: string }
  | { type: "duplicateBot"; botId: string }
  | { type: "markUnread"; botId: string }
  | { type: "botPatched"; bot: Partial<Bot> & { id: string } }
  | { type: "messageAdded"; threadId: string; message: Message }
  | { type: "messagePatched"; threadId: string; message: Message }
  | { type: "streamDelta"; threadId: string; delta: string }
  | { type: "streamClear"; threadId: string }
  | { type: "screenFrame"; botId: string; png: string; mime: string }
  | { type: "provisioning"; botId: string; on: boolean }
  | { type: "setModel"; botId: string; selection: ModelSelection }
  | { type: "interrupt"; botId: string }
  | { type: "connected"; value: boolean }
  | { type: "error"; message: string | null }
  | { type: "toggleSettings"; open?: boolean }
  | { type: "togglePlugins"; open?: boolean }
  | { type: "toggleComputer"; open?: boolean }
  | { type: "toggleAppSettings"; open?: boolean }
  | { type: "toggleRoutines"; open?: boolean; creating?: boolean; botId?: string }
  | { type: "toggleSkills"; open?: boolean }
  | { type: "routinesLoaded"; routines: Routine[] }
  | { type: "routineSaved"; routine: Routine }
  | { type: "routineDeleted"; routineId: string }
  | {
      type: "updateBot";
      botId: string;
      patch: Partial<
        Pick<
          Bot,
          | "name"
          | "title"
          | "description"
          | "notifications"
          | "notifyEvents"
          | "computer"
          | "color"
          | "mascotExpression"
          | "mascotPinned"
          | "iconShape"
          | "avatarNonce"
          | "avatarImageHash"
          | "pinned"
          | "hidden"
          | "requireApproval"
          | "alwaysAllow"
          | "enabledApps"
          | "enabledSkills"
          | "skillId"
        >
      >;
    };

function updateBot(state: AppState, botId: string, fn: (b: Bot) => Bot): AppState {
  return { ...state, bots: state.bots.map((b) => (b.id === botId ? fn(b) : b)) };
}

function withMascotMotion(
  state: AppState,
  botId: string,
  kind: Exclude<MausMotion, "none">,
): AppState {
  return {
    ...state,
    mascotMotion: {
      botId,
      nonce: (state.mascotMotion?.nonce ?? 0) + 1,
      kind,
    },
  };
}

function patchCard(state: AppState, botId: string, messageId: string, patch: Partial<OptionCardData>): AppState {
  return updateBot(state, botId, (b) => ({
    ...b,
    messages: b.messages.map((m) =>
      m.id === messageId && m.card ? { ...m, card: { ...m.card, ...patch } } : m,
    ),
  }));
}

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "hydrate": {
      const selectedId =
        action.bots.some((b) => b.id === state.selectedId) && state.selectedId
          ? state.selectedId
          : (action.bots[0]?.id ?? "");
      return { ...state, bots: action.bots, selectedId };
    }
    case "instances":
      return { ...state, instances: action.instances };
    case "configStatus":
      return { ...state, config: action.config };
    case "routinesLoaded":
      return { ...state, routines: action.routines };
    case "routineSaved":
      return { ...state, routines: state.routines.some((routine) => routine.id === action.routine.id) ? state.routines.map((routine) => routine.id === action.routine.id ? action.routine : routine) : [action.routine, ...state.routines] };
    case "routineDeleted":
      return { ...state, routines: state.routines.filter((routine) => routine.id !== action.routineId) };
    case "select":
      return updateBot(
        withMascotMotion({ ...state, selectedId: action.id }, action.id, "switch"),
        action.id,
        (b) => ({ ...b, unread: false }),
      );
    // optimistic card settle; the server's message.patch confirms it later
    case "answerCard":
      return withMascotMotion(
        patchCard(state, action.botId, action.messageId, { answered: action.answer }),
        action.botId,
        "working",
      );
    case "dismissCard":
      return patchCard(state, action.botId, action.messageId, { dismissed: true });
    case "botAdded": {
      const exists = state.bots.some((b) => b.id === action.bot.id);
      const selectedId = action.select === false ? state.selectedId : action.bot.id;
      if (exists) {
        return selectedId === state.selectedId ? state : { ...state, selectedId };
      }
      return withMascotMotion({
        ...state,
        bots: [action.bot, ...state.bots],
        selectedId,
      }, action.bot.id, "arrive");
    }
    case "deleteBot": {
      if (state.bots.length <= 1) return state;
      const bots = state.bots.filter((b) => b.id !== action.botId);
      const selectedId =
        state.selectedId === action.botId ? (bots.find((b) => !b.hidden)?.id ?? bots[0]?.id ?? "") : state.selectedId;
      const { [action.botId]: _, ...queued } = state.queued;
      return { ...state, bots, selectedId, queued };
    }
    case "markUnread":
      return updateBot(withMascotMotion(state, action.botId, "surprise"), action.botId, (b) => ({ ...b, unread: true }));
    case "botPatched": {
      const before = state.bots.find((b) => b.id === action.bot.id);
      const kind =
        action.bot.unread && !before?.unread
          ? "surprise"
          : action.bot.busy === true && !before?.busy
            ? "working"
            : action.bot.busy === false && before?.busy
              ? "celebrate"
              : null;
      const next = kind ? withMascotMotion(state, action.bot.id, kind) : state;
      return updateBot(next, action.bot.id, (b) => ({ ...b, ...action.bot, messages: b.messages }));
    }
    case "messageAdded": {
      const bot = state.bots.find((b) => b.threadId === action.threadId);
      if (!bot) return state;
      const next = updateBot(state, bot.id, (b) =>
        b.messages.some((m) => m.id === action.message.id)
          ? b
          : { ...b, messages: [...b.messages, action.message] },
      );
      const motion =
        action.message.kind === "options"
          ? "thinking"
          : action.message.kind === "activity"
            ? action.message.tool?.ok === false
              ? "failure"
              : action.message.tool?.ok === true
                ? "success"
                : "working"
            : action.message.role === "bot" && action.message.kind === "text"
              ? "blink"
              : null;
      const animated = motion ? withMascotMotion(next, bot.id, motion) : next;
      // a settled assistant bubble replaces the in-flight stream
      if (action.message.role === "bot" && action.message.kind === "text") {
        const { [action.threadId]: _, ...rest } = animated.streaming;
        return { ...animated, streaming: rest };
      }
      return animated;
    }
    case "messagePatched": {
      const bot = state.bots.find((b) => b.threadId === action.threadId);
      if (!bot) return state;
      const motion =
        action.message.kind === "activity"
          ? action.message.tool?.ok === false
            ? "failure"
            : action.message.tool?.ok === true
              ? "success"
              : "working"
          : null;
      const next = motion ? withMascotMotion(state, bot.id, motion) : state;
      return updateBot(next, bot.id, (b) => ({
        ...b,
        messages: b.messages.map((m) => (m.id === action.message.id ? action.message : m)),
      }));
    }
    case "streamDelta": {
      const stream = appendStreamingResponseText(state.streamingRaw[action.threadId] ?? "", action.delta);
      // The provider appends a machine-readable option trailer. Remove it
      // as soon as its opening marker is complete; the settled message is
      // parsed server-side into a native option card.
      return {
        ...state,
        streaming: {
          ...state.streaming,
          [action.threadId]: stream.visible,
        },
        streamingRaw: { ...state.streamingRaw, [action.threadId]: stream.raw },
      };
    }
    case "streamClear": {
      const { [action.threadId]: _, ...rest } = state.streaming;
      const { [action.threadId]: __, ...rawRest } = state.streamingRaw;
      return { ...state, streaming: rest, streamingRaw: rawRest };
    }
    case "screenFrame":
      return {
        ...withMascotMotion(state, action.botId, "success"),
        screens: { ...state.screens, [action.botId]: { png: action.png, mime: action.mime } },
        provisioning: { ...state.provisioning, [action.botId]: false },
      };
    case "provisioning":
      return {
        ...(action.on ? withMascotMotion(state, action.botId, "launch") : state),
        provisioning: { ...state.provisioning, [action.botId]: action.on },
      };
    case "setModel":
      return updateBot(state, action.botId, (b) => ({ ...b, modelSelection: action.selection }));
    case "connected":
      return { ...state, connected: action.value };
    case "error":
      return {
        ...(action.message && state.selectedId
          ? withMascotMotion(state, state.selectedId, "alert")
          : state),
        error: action.message,
      };
    // bot settings, the computer panel, and app settings share the right slot
    case "toggleSettings": {
      const open = action.open ?? !state.settingsOpen;
      return {
        ...state,
        settingsOpen: open,
        computerOpen: open ? false : state.computerOpen,
        appSettingsOpen: open ? false : state.appSettingsOpen,
        routinesOpen: open ? false : state.routinesOpen,
        skillsOpen: open ? false : state.skillsOpen,
      };
    }
    case "togglePlugins":
      return { ...state, pluginsOpen: action.open ?? !state.pluginsOpen, routinesOpen: false, skillsOpen: false };
    case "toggleComputer": {
      const open = action.open ?? !state.computerOpen;
      return {
        ...state,
        computerOpen: open,
        settingsOpen: open ? false : state.settingsOpen,
        appSettingsOpen: open ? false : state.appSettingsOpen,
        routinesOpen: open ? false : state.routinesOpen,
        skillsOpen: open ? false : state.skillsOpen,
      };
    }
    case "toggleAppSettings": {
      const open = action.open ?? !state.appSettingsOpen;
      return {
        ...state,
        appSettingsOpen: open,
        settingsOpen: open ? false : state.settingsOpen,
        computerOpen: open ? false : state.computerOpen,
        pluginsOpen: open ? false : state.pluginsOpen,
        routinesOpen: open ? false : state.routinesOpen,
        skillsOpen: open ? false : state.skillsOpen,
      };
    }
    case "toggleRoutines": {
      const open = action.open ?? !state.routinesOpen;
      return {
        ...state,
        routinesOpen: open,
        routinesCreating: open ? Boolean(action.creating) : false,
        routineCreateBotId: open && action.creating ? (action.botId ?? state.selectedId) : null,
        settingsOpen: open ? false : state.settingsOpen,
        computerOpen: open ? false : state.computerOpen,
        appSettingsOpen: open ? false : state.appSettingsOpen,
        pluginsOpen: open ? false : state.pluginsOpen,
        skillsOpen: open ? false : state.skillsOpen,
      };
    }
    case "toggleSkills": {
      const open = action.open ?? !state.skillsOpen;
      return {
        ...state,
        skillsOpen: open,
        settingsOpen: open ? false : state.settingsOpen,
        computerOpen: open ? false : state.computerOpen,
        appSettingsOpen: open ? false : state.appSettingsOpen,
        pluginsOpen: open ? false : state.pluginsOpen,
        routinesOpen: open ? false : state.routinesOpen,
      };
    }
    case "updateBot": {
      const mascotChanged =
        Object.prototype.hasOwnProperty.call(action.patch, "color") ||
        Object.prototype.hasOwnProperty.call(action.patch, "mascotExpression") ||
        Object.prototype.hasOwnProperty.call(action.patch, "iconShape");
      const next = mascotChanged
        ? withMascotMotion(state, action.botId, "customize")
        : state;
      return updateBot(next, action.botId, (b) => ({ ...b, ...action.patch }));
    }
    case "enqueue":
      return {
        ...state,
        queued: {
          ...state.queued,
          [action.botId]: enqueuePrompt(state.queued[action.botId] ?? [], action.item),
        },
      };
    case "cancelQueued":
      return {
        ...state,
        queued: {
          ...state.queued,
          [action.botId]: cancelPrompt(state.queued[action.botId] ?? [], action.id),
        },
      };
    case "flushQueue": {
      const bot = state.bots.find((b) => b.id === action.botId);
      const { next, rest } = takeNext(state.queued[action.botId] ?? []);
      if (!bot || bot.busy || !next) return state;
      return {
        ...withMascotMotion(updateBot(state, action.botId, (b) => ({ ...b, busy: true })), action.botId, "working"),
        queued: { ...state.queued, [action.botId]: rest },
      };
    }
    // wrapper POSTs; busy flips now so a follow-up Enter queues instead of racing
    case "send":
      return withMascotMotion(
        updateBot(state, action.botId, (b) => ({ ...b, busy: true })),
        action.botId,
        "working",
      );
    case "newBot":
    case "duplicateBot":
    case "interrupt":
      return state;
  }
}

export const initialState: AppState = {
  bots: [],
  instances: [],
  config: null,
  selectedId: "",
  settingsOpen: false,
  pluginsOpen: false,
  computerOpen: false,
  appSettingsOpen: false,
  routinesOpen: false,
  skillsOpen: false,
  routinesCreating: false,
  routineCreateBotId: null,
  routines: [],
  streaming: {},
  streamingRaw: {},
  screens: {},
  provisioning: {},
  connected: false,
  error: null,
  mascotMotion: null,
  queued: {},
};

// ── API client ─────────────────────────────────────────────────────────
export async function api(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...init,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  return body;
}

const StoreContext = createContext<{
  state: AppState;
  dispatch: React.Dispatch<Action>;
} | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, rawDispatch] = useReducer(reducer, initialState);
  const stateRef = useRef(state);
  stateRef.current = state;

  // debounced PATCH per bot for text-field edits (name/title/description)
  const patchTimers = useRef(new Map<string, { timer: ReturnType<typeof setTimeout>; patch: Record<string, unknown> }>());

  const dispatch = useMemo(() => {
    const showError = (e: unknown) => {
      rawDispatch({ type: "error", message: e instanceof Error ? e.message : String(e) });
      setTimeout(() => rawDispatch({ type: "error", message: null }), 6000);
    };
    // fire-and-forget card persistence; the route is optional server-side
    const persistCard = (botId: string, messageId: string, patch: Partial<OptionCardData>) => {
      fetch(`/api/bots/${botId}/cards/${messageId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      }).catch(() => {});
    };
    let queueSeq = 0;
    const posting = new Set<string>();
    const postMessage = (
      botId: string,
      text: string,
      attachments?: Array<{ path: string; mime?: string }>,
      mentionSkillIds?: string[],
    ) => {
      posting.add(botId);
      api(`/api/bots/${botId}/messages`, {
        method: "POST",
        body: JSON.stringify({ text, attachments: attachments ?? [], mentionSkillIds: mentionSkillIds ?? [] }),
      })
        .catch((e) => {
          rawDispatch({ type: "botPatched", bot: { id: botId, busy: false } });
          showError(e);
        })
        .finally(() => posting.delete(botId));
    };

    const wrapped: React.Dispatch<Action> = (action) => {
      if (action.type === "send") {
        const bot = stateRef.current.bots.find((b) => b.id === action.botId);
        if (shouldEnqueueSend(bot?.busy === true, posting.has(action.botId))) {
          rawDispatch({
            type: "enqueue",
            botId: action.botId,
            item: {
              id: `q-${++queueSeq}`,
              text: action.text,
              attachments: action.attachments ?? [],
              mentionSkillIds: action.mentionSkillIds ?? [],
            },
          });
          return;
        }
        rawDispatch(action);
        postMessage(action.botId, action.text, action.attachments, action.mentionSkillIds);
        return;
      }
      if (action.type === "flushQueue") {
        const bot = stateRef.current.bots.find((b) => b.id === action.botId);
        const { next } = takeNext(stateRef.current.queued[action.botId] ?? []);
        if (!bot || bot.busy || posting.has(action.botId) || !next) return;
        rawDispatch(action);
        postMessage(action.botId, next.text, next.attachments, next.mentionSkillIds);
        return;
      }
      rawDispatch(action);
      switch (action.type) {
        case "answerCard": {
          const bot = stateRef.current.bots.find((b) => b.id === action.botId);
          const card = bot?.messages.find((m) => m.id === action.messageId)?.card;
          if (card?.requestId) {
            const credential = card.requestType === "credential";
            const behavior = credential
              ? /deny|dismiss|cancel/i.test(action.answer)
                ? "deny"
                : "allow"
              : action.answer === "Allow once" || action.answer === "Allow"
                ? "allow"
                : action.answer === "Deny"
                  ? "deny"
                  : "answer";
            api(`/api/bots/${action.botId}/respond`, {
              method: "POST",
              body: JSON.stringify({
                requestId: card.requestId,
                behavior,
                message: action.secret ?? (behavior === "answer" ? action.answer : undefined),
                always: action.always === true,
                ...(action.always === true ? { persistScope: action.persistScope ?? "bot" } : {}),
              }),
            }).catch(showError);
          } else if (card?.requestType === "suggestion") {
            persistCard(action.botId, action.messageId, { answered: action.answer });
          } else {
            persistCard(action.botId, action.messageId, { answered: action.answer });
            api(`/api/bots/${action.botId}/messages`, {
              method: "POST",
              body: JSON.stringify({ text: action.answer }),
            }).catch(showError);
          }
          break;
        }
        case "dismissCard": {
          const bot = stateRef.current.bots.find((b) => b.id === action.botId);
          const card = bot?.messages.find((m) => m.id === action.messageId)?.card;
          if (card?.requestId) {
            api(`/api/bots/${action.botId}/respond`, {
              method: "POST",
              body: JSON.stringify({ requestId: card.requestId, behavior: "deny", message: "Dismissed by user." }),
            }).catch(() => {});
          } else {
            persistCard(action.botId, action.messageId, { dismissed: true });
          }
          break;
        }
        case "newBot":
          api("/api/bots", { method: "POST" })
            .then(({ bot }) => rawDispatch({ type: "botAdded", bot }))
            .catch(showError);
          break;
        case "duplicateBot": {
          const source = stateRef.current.bots.find((b) => b.id === action.botId);
          if (!source) break;
          api("/api/bots", { method: "POST" })
            .then(({ bot }) =>
              api(`/api/bots/${bot.id}`, {
                method: "PATCH",
                body: JSON.stringify({
                  name: `${source.name} copy`,
                  title: source.title,
                  description: source.description,
                  notifications: source.notifications,
                  notifyEvents: source.notifyEvents,
                  modelSelection: source.modelSelection,
                  ...(source.computer ? { computer: source.computer } : {}),
                }),
              }).then(({ bot: patched }) =>
                rawDispatch({ type: "botAdded", bot: { ...bot, ...patched, messages: bot.messages } }),
              ),
            )
            .catch(showError);
          break;
        }
        case "deleteBot":
          if (stateRef.current.bots.length <= 1) break;
          api(`/api/bots/${action.botId}`, { method: "DELETE" }).catch(showError);
          break;
        case "markUnread":
          api(`/api/bots/${action.botId}`, { method: "PATCH", body: JSON.stringify({ unread: true }) }).catch(
            () => {},
          );
          break;
        case "select": {
          const bot = stateRef.current.bots.find((b) => b.id === action.id);
          if (bot?.unread) {
            api(`/api/bots/${action.id}`, { method: "PATCH", body: JSON.stringify({ unread: false }) }).catch(() => {});
          }
          break;
        }
        case "setModel":
          api(`/api/bots/${action.botId}`, {
            method: "PATCH",
            body: JSON.stringify({ modelSelection: action.selection }),
          }).catch(showError);
          break;
        case "interrupt":
          api(`/api/bots/${action.botId}/interrupt`, { method: "POST" }).catch(showError);
          break;
        case "updateBot": {
          const timers = patchTimers.current;
          const pending = timers.get(action.botId);
          const patch = { ...pending?.patch, ...action.patch };
          if (pending) clearTimeout(pending.timer);
          timers.set(action.botId, {
            patch,
            timer: setTimeout(() => {
              timers.delete(action.botId);
              api(`/api/bots/${action.botId}`, { method: "PATCH", body: JSON.stringify(patch) }).catch(showError);
            }, 400),
          });
          break;
        }
        default:
          break;
      }
    };
    return wrapped;
  }, []);

  // Drain one queued follow-up when a bot becomes idle. Interrupt leaves
  // the queue in place; cancelQueued removes an item before this runs.
  useEffect(() => {
    for (const botId of nextFlushBotIds(state.bots, state.queued)) {
      dispatch({ type: "flushQueue", botId });
    }
  }, [state.bots, state.queued, dispatch]);

  // ── initial load + SSE fold (P1.3 resumable stream) ──────────────────
  // Snapshot + cursor + Last-Event-ID replay: hydrate from
  // /api/events/snapshot, subscribe from the cursor it was taken at, skip
  // anything at or before the last applied sequence. A reload or dropped
  // connection replays exactly the missed frames — no loss, no dupes.
  useEffect(() => {
    let alive = true;
    let es: EventSource | null = null;
    let cursor: SseCursor = INITIAL_CURSOR;
    const loadExtras = () => {
      api("/api/instances")
        .then(({ instances }) => alive && rawDispatch({ type: "instances", instances }))
        .catch(() => {});
      api("/api/config")
        .then((config) => alive && rawDispatch({ type: "configStatus", config }))
        .catch(() => {});
      api("/api/routines")
        .then(({ routines }) => alive && rawDispatch({ type: "routinesLoaded", routines }))
        .catch(() => {});
    };
    // sequenced frames received while a snapshot fetch is in flight are
    // buffered and re-folded against the snapshot's cursor afterwards — a
    // frame newer than the snapshot must not be wiped by the hydrate
    let pendingDuringResync: any[] | null = null;
    const resync = () => {
      pendingDuringResync ??= [];
      return api("/api/events/snapshot")
        .then((snap) => {
          if (!alive) return;
          rawDispatch({ type: "hydrate", bots: snap.bots });
          // SET (not advance): a resync is also the recovery from a
          // reset stream whose sequences restarted below our old cursor
          cursor = {
            streamId: typeof snap.streamId === "string" ? snap.streamId : null,
            sequence: typeof snap.sequence === "number" ? snap.sequence : 0,
          };
        })
        .catch(() => {})
        .then(() => {
          const queued = pendingDuringResync ?? [];
          pendingDuringResync = null;
          for (const frame of queued) foldFrame(frame);
        });
    };
    loadExtras();

    const connect = () => {
      if (!alive) return;
      es = new EventSource(eventsUrl(cursor));
      es.onopen = () => rawDispatch({ type: "connected", value: true });
      es.onerror = () => rawDispatch({ type: "connected", value: false });
      es.onmessage = (raw: MessageEvent) => {
        let frame: any;
        try {
          frame = JSON.parse(raw.data);
        } catch {
          return;
        }
        foldFrame(frame);
      };
    };
    const foldFrame = (frame: any) => {
      if (frame.kind === "hello") {
        // the server could not resume our cursor (fresh page, pruned or
        // reset stream) — fall back to a full snapshot resync
        if (frame.resumed === false) {
          void resync();
          loadExtras();
        }
        return;
      }
      if (pendingDuringResync && typeof frame.sequence === "number") {
        pendingDuringResync.push(frame);
        return;
      }
      if (!shouldApplyFrame(cursor, frame)) return; // replay overlap — already applied
      cursor = advanceCursor(cursor, frame);
      switch (frame.kind) {
        case "message":
          rawDispatch({ type: "messageAdded", threadId: frame.threadId, message: frame.message });
          break;
        case "message.patch":
          rawDispatch({ type: "messagePatched", threadId: frame.threadId, message: frame.message });
          break;
        case "bot": {
          const bot = frame.bot as Partial<Bot> & { id: string };
          // reading the selected chat clears its badge immediately
          if (bot.unread && bot.id === stateRef.current.selectedId) {
            bot.unread = false;
            fetch(`/api/bots/${bot.id}`, {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ unread: false }),
            }).catch(() => {});
          }
          rawDispatch({ type: "botPatched", bot });
          break;
        }
        case "bot.added":
          rawDispatch({ type: "botAdded", bot: frame.bot, select: false });
          break;
        case "runtime": {
          const event = frame.event;
          if (event.type === "content.delta" && event.streamKind === "assistant_text") {
            rawDispatch({ type: "streamDelta", threadId: event.threadId, delta: event.delta });
          } else if (event.type === "turn.completed") {
            rawDispatch({ type: "streamClear", threadId: event.threadId });
          }
          const bot = stateRef.current.bots.find((b) => b.threadId === event.threadId);
          const copy = bot ? notifyCopy(bot, event) : null;
          if (copy && bot && window.ogb?.notify) {
            void window.ogb.notify({ ...copy, botId: bot.id });
          }
          break;
        }
        case "nudge": {
          const nudged = stateRef.current.bots.find((b) => b.id === frame.botId);
          const copy = nudged ? notifyCopy(nudged, { type: "stall.nudge" }) : null;
          if (copy && nudged && window.ogb?.notify) {
            void window.ogb.notify({ ...copy, botId: nudged.id });
          }
          break;
        }
        case "peer.reply": {
          const owner = stateRef.current.bots.find((b) => b.id === frame.botId);
          const copy = owner ? notifyCopy(owner, { type: "peer.reply" }) : null;
          if (copy && owner && window.ogb?.notify) {
            void window.ogb.notify({ ...copy, botId: owner.id });
          }
          break;
        }
        case "screen":
          rawDispatch({ type: "screenFrame", botId: frame.botId, png: frame.png, mime: frame.mime ?? "image/png" });
          break;
        case "computer":
          rawDispatch({ type: "provisioning", botId: frame.botId, on: frame.state === "provisioning" });
          break;
        case "bot.deleted":
          rawDispatch({ type: "deleteBot", botId: frame.botId });
          break;
        case "routine":
          rawDispatch({ type: "routineSaved", routine: frame.routine });
          break;
        case "routine.deleted":
          rawDispatch({ type: "routineDeleted", routineId: frame.routineId });
          break;
        // a key changed and the fleet hot-reloaded — refresh the picker so
        // newly available providers un-dim immediately
        case "config":
          rawDispatch({
            type: "configStatus",
            config: {
              xai: frame.xai,
              composio: frame.composio,
              box: frame.box,
              github: frame.github,
              openai: frame.openai,
              openrouter: frame.openrouter,
              omnirouter: frame.omnirouter,
            },
          });
          api("/api/instances")
            .then(({ instances }) => rawDispatch({ type: "instances", instances }))
            .catch(() => {});
          break;
      }
    };
    // hydrate first, then subscribe from the snapshot's cursor. When the
    // snapshot fails (server still booting) we connect anyway: the hello
    // arrives with resumed=false and triggers the resync above.
    void resync().then(connect);
    return () => {
      alive = false;
      es?.close();
    };
  }, []);

  useEffect(() => window.ogb?.onNotifyClick?.((botId) => dispatch({ type: "select", id: botId })), [dispatch]);

  useEffect(() => {
    const tray = window.ogb?.tray;
    if (!tray?.setUnread) return;
    void tray.setUnread(unreadBotCount(state.bots));
  }, [state.bots]);

  const value = useMemo(() => ({ state, dispatch }), [state, dispatch]);
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore() {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error("useStore outside provider");
  return ctx;
}

export function formatTime(at: number) {
  return new Date(at).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}
