// Optional Telegram chat interface. Desktop runtime long-polls getUpdates
// (no webhook, no cloud relay). Token lives in the SecretStore. Empty
// allowlist denies everyone. Outbound text always goes through redaction.
import { redactCommand } from "./activity-status.ts";
import {
  enforceChannelUploadLimits,
  type ChannelAttachmentCandidate,
} from "./attachments/channel-limits.ts";
import type { AppConfig } from "./config.ts";
import { redactSecrets } from "./redact-text.ts";
import type { BotsService } from "./services/bots.ts";
import { getSidebarSection } from "./sidebar-sections.ts";
import type { TelegramApi, TelegramApiUpdate } from "./telegram-api.ts";
import type { TelegramConversationsRepository } from "./repositories/telegram-conversations.ts";
import type { LineageService } from "./services/lineage.ts";
import {
  createTelegramApprovalStore,
  formatTelegramApprovalText,
  soleBoundTelegramConversation,
  telegramApprovalKeyboard,
  telegramApprovalProjectLabel,
  telegramApprovalTerminalLabel,
  terminalFromCardAnswer,
  type TelegramApprovalChoice,
  type TelegramApprovalRecord,
  type TelegramApprovalTerminal,
} from "./telegram-approvals.ts";
import {
  AUTONOMY_STOP,
  isWorkflowStatus,
  waitingLabel,
  workflowLabel,
  type WorkflowStatus,
  type WorkflowWaitingFor,
} from "./workflow.ts";

export const TELEGRAM_RUNTIME_STATUSES = [
  "disconnected",
  "connecting",
  "connected",
  "connection_failed",
  "offline",
] as const;

export type TelegramRuntimeStatus = (typeof TELEGRAM_RUNTIME_STATUSES)[number];

export interface TelegramConfigStatus {
  configured: boolean;
  enabled: boolean;
  defaultBotId?: string;
  allowlist: string[];
  status: TelegramRuntimeStatus;
  statusMessage: string;
}

export interface TelegramIdentity {
  userId: string;
  chatId: string;
  username?: string;
}

export interface TelegramInbound {
  updateId: number;
  identity: TelegramIdentity;
  text: string;
}

export const TELEGRAM_COPY = {
  disconnected:
    "Telegram is disconnected. Paste a bot token from @BotFather, pick an agent, and add an allowlist to connect.",
  connecting: "Connecting to Telegram…",
  connected: "Telegram is connected. Authorized chats can message the selected agent.",
  connectedEmptyAllowlist:
    "Connected to Telegram, but the allowlist is empty. Add a Telegram user ID or chat ID or nobody is authorized.",
  noAgent: "No agent is selected. Choose which VelarixBot agent receives Telegram conversations.",
  offline:
    "VelarixBot is offline. Start the desktop app so Telegram messages can be received and answered.",
  unauthorized: "You are not authorized to use this VelarixBot.",
  disabled: "Telegram is disabled in VelarixBot settings.",
  busy: "This agent is already working. Wait for it to finish, or interrupt the turn in VelarixBot.",
  start: (agent: string) => `Connected to ${agent}. Messages in this chat stay in that conversation.`,
  connectionFailed(detail: string): string {
    return `Could not reach Telegram. ${detail} Messages wait until this desktop runtime can connect again.`;
  },
};

const MAX_TELEGRAM_TEXT = 4000;

export function normalizeAllowlistEntry(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^-?\d+$/.test(trimmed)) return trimmed;
  const name = trimmed.replace(/^@/, "").trim();
  if (!name || /\s/.test(name)) return null;
  return `@${name}`;
}

export function parseAllowlist(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const entry = normalizeAllowlistEntry(item);
    if (!entry) continue;
    const key = entry.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

export function isTelegramAuthorized(allowlist: string[], identity: TelegramIdentity): boolean {
  if (allowlist.length === 0) return false;
  const userId = identity.userId.trim();
  const chatId = identity.chatId.trim();
  const username = identity.username?.replace(/^@/, "").trim().toLowerCase();
  for (const raw of allowlist) {
    const entry = normalizeAllowlistEntry(raw);
    if (!entry) continue;
    if (entry === userId || entry === chatId) return true;
    if (username && entry.startsWith("@") && entry.slice(1).toLowerCase() === username) return true;
  }
  return false;
}

export function telegramSafeText(text: string): string {
  return redactSecrets(String(text ?? "")).slice(0, MAX_TELEGRAM_TEXT);
}

export function enforceTelegramAttachmentBounds(
  attachments: ChannelAttachmentCandidate[] | undefined,
  limits: { maxCount?: number; maxBytes?: number } = {},
) {
  return enforceChannelUploadLimits("telegram", attachments, limits);
}

/** Send-path gate: redact text and reject oversize/count before Telegram I/O. */
export function prepareTelegramSend(input: {
  text: string;
  attachments?: ChannelAttachmentCandidate[];
}): { ok: true; text: string; attachments: ChannelAttachmentCandidate[] } | { ok: false; error: string } {
  const bounds = enforceTelegramAttachmentBounds(input.attachments);
  if (!bounds.ok) return bounds;
  return { ok: true, text: telegramSafeText(input.text), attachments: bounds.attachments };
}

export function telegramSafeCommand(command: string): string {
  return telegramSafeText(redactCommand(command));
}

export function telegramWorkflowNotice(
  status: WorkflowStatus,
  waitingFor?: WorkflowWaitingFor[] | null,
  stopReason?: string | null,
): string {
  const label = workflowLabel(status, waitingFor);
  if (status === "waiting") return telegramSafeText(waitingLabel(waitingFor));
  if (status === "blocked") {
    const detail = stopReason?.trim() ? ` — ${telegramSafeText(stopReason)}` : "";
    return `Blocked${detail}`;
  }
  if (status === "needs_input") return "Needs input — reply here, or open VelarixBot if a secret is required.";
  if (status === "completed") return "Completed";
  if (status === "paused") return "Paused";
  return label;
}

export function decodeTelegramSettings(telegram: AppConfig["telegram"]): {
  token?: string;
  enabled: boolean;
  defaultBotId?: string;
  allowlist: string[];
} {
  const token = typeof telegram?.token === "string" && telegram.token.trim() ? telegram.token : undefined;
  const defaultBotId =
    typeof telegram?.defaultBotId === "string" && telegram.defaultBotId.trim()
      ? telegram.defaultBotId.trim()
      : undefined;
  return {
    ...(token ? { token } : {}),
    enabled: telegram?.enabled === true,
    ...(defaultBotId ? { defaultBotId } : {}),
    allowlist: parseAllowlist(telegram?.allowlist),
  };
}

export function parseTelegramUpdate(update: TelegramApiUpdate): TelegramInbound | null {
  const message = update.message;
  if (!message || typeof update.update_id !== "number") return null;
  const text = typeof message.text === "string" ? message.text.trim() : "";
  if (!text) return null;
  const chatId = message.chat?.id;
  if (chatId === undefined || chatId === null) return null;
  const userId = message.from?.id ?? chatId;
  const username = typeof message.from?.username === "string" ? message.from.username : undefined;
  return {
    updateId: update.update_id,
    identity: {
      userId: String(userId),
      chatId: String(chatId),
      ...(username ? { username } : {}),
    },
    text,
  };
}

export interface TelegramCallback {
  updateId: number;
  callbackQueryId: string;
  data: string;
  fromUserId: string;
  chatId: string;
  messageId?: number;
}

export function parseTelegramCallback(update: TelegramApiUpdate): TelegramCallback | null {
  const query = update.callback_query;
  if (!query || typeof update.update_id !== "number") return null;
  const data = typeof query.data === "string" ? query.data.trim() : "";
  if (!data) return null;
  const chatId = query.message?.chat?.id;
  if (chatId === undefined || chatId === null) return null;
  const fromId = query.from?.id;
  if (fromId === undefined || fromId === null) return null;
  return {
    updateId: update.update_id,
    callbackQueryId: query.id,
    data,
    fromUserId: String(fromId),
    chatId: String(chatId),
    ...(typeof query.message?.message_id === "number" ? { messageId: query.message.message_id } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export interface TelegramPermissionApprovalInput {
  botId: string;
  requestId: string;
  tool: string;
  summary: string;
}

export interface TelegramService {
  publicStatus(): TelegramConfigStatus;
  applyConfig(): void;
  handleUpdate(update: TelegramApiUpdate): Promise<void>;
  pollOnce(): Promise<void>;
  onBroadcast(payload: unknown): void;
  notifyPermissionApproval(input: TelegramPermissionApprovalInput): void;
  stop(): void;
}

export function createTelegramService(deps: {
  cfg: () => AppConfig;
  api: TelegramApi;
  conversations: TelegramConversationsRepository;
  bots: BotsService;
  startTurn: (botId: string, text: string, opts?: { unattended?: boolean; idempotencyKey?: string; requestId?: string }) => Promise<unknown>;
  now: () => number;
  onStatusChange?: () => void;
  lineage?: LineageService;
  answerPermission?: (botId: string, requestId: string, behavior: TelegramApprovalChoice) => Promise<unknown>;
  markPermissionTerminal?: (botId: string, requestId: string, answered: string) => void;
}): TelegramService {
  let running = false;
  let abort: AbortController | null = null;
  let offset = 0;
  let runtimeStatus: TelegramRuntimeStatus = "disconnected";
  let runtimeDetail = TELEGRAM_COPY.disconnected;
  const originByThread = new Map<string, string>();
  const lastWorkflow = new Map<string, string>();
  const approvals = createTelegramApprovalStore({ now: () => deps.now() });

  function settings() {
    return decodeTelegramSettings(deps.cfg().telegram);
  }

  function setRuntime(status: TelegramRuntimeStatus, message: string) {
    if (runtimeStatus === status && runtimeDetail === message) return;
    runtimeStatus = status;
    runtimeDetail = message;
    deps.onStatusChange?.();
  }

  function publicStatus(): TelegramConfigStatus {
    const { token, enabled, defaultBotId, allowlist } = settings();
    const configured = Boolean(token);
    if (!enabled || !configured) {
      return {
        configured,
        enabled,
        ...(defaultBotId ? { defaultBotId } : {}),
        allowlist,
        status: "disconnected",
        statusMessage: TELEGRAM_COPY.disconnected,
      };
    }
    let status = runtimeStatus === "disconnected" ? ("connecting" as const) : runtimeStatus;
    let statusMessage = runtimeStatus === "disconnected" ? TELEGRAM_COPY.connecting : runtimeDetail;
    if (allowlist.length === 0) {
      statusMessage = TELEGRAM_COPY.connectedEmptyAllowlist;
    } else if (!defaultBotId) {
      statusMessage = TELEGRAM_COPY.noAgent;
    }
    return {
      configured,
      enabled,
      ...(defaultBotId ? { defaultBotId } : {}),
      allowlist,
      status,
      statusMessage,
    };
  }

  function isLive(): boolean {
    const { token, enabled } = settings();
    return enabled && Boolean(token);
  }

  async function sendSafe(
    chatId: string,
    text: string,
    attachments?: ChannelAttachmentCandidate[],
    requestId?: string,
  ): Promise<void> {
    const { token } = settings();
    if (!token || !isLive()) return;
    const prepared = prepareTelegramSend({ text, attachments });
    if (!prepared.ok || !prepared.text) return;
    try {
      await deps.api.sendMessage(token, chatId, prepared.text);
    } catch {
      return;
    }
    if (requestId) deps.lineage?.noteOutbound(requestId, `telegram:${chatId}`);
  }

  function approvalText(record: TelegramApprovalRecord, terminal?: TelegramApprovalTerminal): string {
    return formatTelegramApprovalText({
      agentName: record.agentName,
      projectLabel: record.projectLabel,
      action: record.action,
      target: record.target,
      ...(terminal ? { terminal: telegramApprovalTerminalLabel(terminal) } : {}),
    });
  }

  async function answerQuietly(callbackQueryId: string, text?: string): Promise<void> {
    const { token } = settings();
    if (!token || !isLive()) return;
    try {
      await deps.api.answerCallbackQuery(token, callbackQueryId, text);
    } catch {
      /* acknowledging a tap must not change agent state */
    }
  }

  async function editApprovalMessage(record: TelegramApprovalRecord, terminal: TelegramApprovalTerminal): Promise<void> {
    const { token } = settings();
    if (!token || !record.messageId) return;
    try {
      await deps.api.editMessageText(token, record.chatId, record.messageId, approvalText(record, terminal));
    } catch {
      /* desktop card is the source of truth if Telegram edit fails */
    }
  }

  async function markExpired(record: TelegramApprovalRecord): Promise<void> {
    if (!record.settled) approvals.settle(record.requestId, "expired");
    deps.markPermissionTerminal?.(record.botId, record.requestId, "expired");
    await editApprovalMessage(record, "expired");
  }

  async function expireApprovals(): Promise<void> {
    for (const record of approvals.expireDue()) {
      await markExpired(record);
    }
  }

  async function deliverPermissionApproval(input: TelegramPermissionApprovalInput): Promise<void> {
    if (!isLive()) return;
    const bot = deps.bots.bot(input.botId);
    if (!bot || bot.hidden) return;
    const linked = soleBoundTelegramConversation(deps.conversations.listByBot(bot.id));
    if (!linked?.userId) return;
    if (approvals.getByRequest(input.requestId)) return;
    const { token } = settings();
    if (!token) return;
    const projectLabel = telegramApprovalProjectLabel({
      title: bot.title,
      sectionName: bot.sectionId ? getSidebarSection(bot.sectionId)?.name : undefined,
    });
    const record = approvals.create({
      requestId: input.requestId,
      botId: bot.id,
      threadId: bot.threadId,
      chatId: linked.chatId,
      userId: linked.userId,
      agentName: bot.name,
      ...(projectLabel ? { projectLabel } : {}),
      action: input.tool,
      target: input.summary,
    });
    try {
      const sent = await deps.api.sendMessage(token, linked.chatId, approvalText(record), {
        replyMarkup: telegramApprovalKeyboard(record.allowCallbackId, record.denyCallbackId),
      });
      if (sent.messageId) approvals.attachMessage(input.requestId, sent.messageId);
      lastWorkflow.set(linked.chatId, "blocked");
    } catch {
      approvals.discard(input.requestId);
    }
  }

  function notifyPermissionApproval(input: TelegramPermissionApprovalInput): void {
    void deliverPermissionApproval(input);
  }

  async function handleCallback(callback: TelegramCallback): Promise<void> {
    if (!isLive()) return;
    await expireApprovals();
    const mapped = approvals.getByCallback(callback.data);
    if (!mapped) {
      await answerQuietly(callback.callbackQueryId);
      return;
    }
    const { record, choice } = mapped;
    if (callback.fromUserId !== record.userId || callback.chatId !== record.chatId) {
      await answerQuietly(callback.callbackQueryId, "You cannot approve this request.");
      return;
    }
    if (record.settled) {
      await answerQuietly(callback.callbackQueryId);
      return;
    }
    if (deps.now() >= record.expiresAt) {
      await markExpired(record);
      await answerQuietly(callback.callbackQueryId, "This approval expired.");
      return;
    }
    const settled = approvals.settle(record.requestId, choice);
    if (!settled || settled.settled !== choice) {
      await answerQuietly(callback.callbackQueryId);
      return;
    }
    try {
      await deps.answerPermission?.(record.botId, record.requestId, choice);
    } catch {
      /* first valid decision already won; do not start another turn */
    }
    await editApprovalMessage(record, choice);
    await answerQuietly(callback.callbackQueryId);
  }

  function resolveAgent(): { id: string; name: string; threadId: string } | null {
    const { defaultBotId } = settings();
    if (!defaultBotId) return null;
    const bot = deps.bots.bot(defaultBotId);
    if (!bot || bot.hidden) return null;
    return { id: bot.id, name: bot.name, threadId: bot.threadId };
  }

  async function handleInbound(inbound: TelegramInbound): Promise<void> {
    const { allowlist } = settings();
    if (!isLive()) return;
    if (!isTelegramAuthorized(allowlist, inbound.identity)) {
      await sendSafe(inbound.identity.chatId, TELEGRAM_COPY.unauthorized);
      return;
    }
    const agent = resolveAgent();
    if (!agent) {
      await sendSafe(inbound.identity.chatId, TELEGRAM_COPY.noAgent);
      return;
    }
    const command = inbound.text.split(/\s+/, 1)[0]?.replace(/@\w+$/, "") ?? inbound.text;
    if (command === "/start") {
      deps.conversations.upsert({
        chatId: inbound.identity.chatId,
        userId: inbound.identity.userId,
        botId: agent.id,
        threadId: agent.threadId,
        now: deps.now(),
      });
      await sendSafe(inbound.identity.chatId, TELEGRAM_COPY.start(agent.name));
      return;
    }
    deps.conversations.upsert({
      chatId: inbound.identity.chatId,
      userId: inbound.identity.userId,
      botId: agent.id,
      threadId: agent.threadId,
      now: deps.now(),
    });
    originByThread.set(agent.threadId, inbound.identity.chatId);
    const requestId = deps.lineage?.begin({
      source: "channel",
      sourceRef: `telegram:${inbound.updateId}`,
      botId: agent.id,
      threadId: agent.threadId,
    }).requestId;
    try {
      await deps.startTurn(agent.id, inbound.text, {
        unattended: true,
        idempotencyKey: `channel:telegram:${inbound.updateId}`,
        ...(requestId ? { requestId } : {}),
      });
      lastWorkflow.set(inbound.identity.chatId, "working");
      await sendSafe(inbound.identity.chatId, telegramWorkflowNotice("working"), undefined, requestId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "could not start a turn";
      if (/already working/i.test(message)) {
        await sendSafe(inbound.identity.chatId, TELEGRAM_COPY.busy);
        return;
      }
      await sendSafe(inbound.identity.chatId, telegramSafeText(`Could not start a turn. ${message}`));
    }
  }

  async function handleUpdate(update: TelegramApiUpdate): Promise<void> {
    if (!isLive()) return;
    const callback = parseTelegramCallback(update);
    if (callback) {
      await handleCallback(callback);
      return;
    }
    const inbound = parseTelegramUpdate(update);
    if (!inbound) return;
    await handleInbound(inbound);
  }

  async function pollOnce(): Promise<void> {
    const { token, enabled } = settings();
    if (!enabled || !token) {
      setRuntime("disconnected", TELEGRAM_COPY.disconnected);
      return;
    }
    if (runtimeStatus === "disconnected" || runtimeStatus === "connection_failed") {
      setRuntime("connecting", TELEGRAM_COPY.connecting);
    }
    try {
      const updates = await deps.api.getUpdates(token, offset, abort?.signal);
      if (!isLive()) return;
      setRuntime("connected", TELEGRAM_COPY.connected);
      await expireApprovals();
      for (const update of updates) {
        if (!isLive()) return;
        if (typeof update.update_id === "number") offset = Math.max(offset, update.update_id + 1);
        await handleUpdate(update);
      }
    } catch (error) {
      if (abort?.signal.aborted) return;
      const detail = error instanceof Error ? error.message : "unknown error";
      setRuntime("connection_failed", TELEGRAM_COPY.connectionFailed(telegramSafeText(detail)));
    }
  }

  function stop() {
    running = false;
    abort?.abort();
    abort = null;
    setRuntime("disconnected", TELEGRAM_COPY.disconnected);
  }

  function waitForAbort(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
      const signal = abort?.signal;
      if (!signal) return;
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  function start() {
    if (running) return;
    running = true;
    abort = new AbortController();
    setRuntime("connecting", TELEGRAM_COPY.connecting);
    void (async () => {
      while (running && isLive()) {
        await pollOnce();
        if (!running || !isLive()) return;
        if (runtimeStatus === "connection_failed") await waitForAbort(2_000);
      }
    })();
  }

  function applyConfig() {
    if (isLive()) start();
    else stop();
  }

  function chatIdsFor(threadId: string, botId?: string): string[] {
    const origin = originByThread.get(threadId);
    if (origin) return [origin];
    const fromThread = deps.conversations.listByThread(threadId).map((row) => row.chatId);
    if (fromThread.length) return fromThread;
    if (botId) return deps.conversations.listByBot(botId).map((row) => row.chatId);
    return [];
  }

  function syncDesktopDecision(payload: unknown) {
    if (!isRecord(payload) || (payload.kind !== "message" && payload.kind !== "message.patch")) return;
    if (!isRecord(payload.message) || !isRecord(payload.message.card)) return;
    const requestId = typeof payload.message.card.requestId === "string" ? payload.message.card.requestId : "";
    const answered = typeof payload.message.card.answered === "string" ? payload.message.card.answered : "";
    if (!requestId || !answered) return;
    const terminal = terminalFromCardAnswer(answered);
    const record = approvals.getByRequest(requestId);
    if (!record || !terminal) return;
    if (!record.settled) approvals.settle(requestId, terminal);
    if (record.settled) void editApprovalMessage(record, record.settled);
  }

  function onBroadcast(payload: unknown) {
    if (!isLive() || !isRecord(payload)) return;
    syncDesktopDecision(payload);
    if (payload.kind === "bot" && isRecord(payload.bot)) {
      const bot = payload.bot;
      const threadId = typeof bot.threadId === "string" ? bot.threadId : "";
      const botId = typeof bot.id === "string" ? bot.id : "";
      if (!threadId) return;
      const chats = chatIdsFor(threadId, botId);
      if (!chats.length) return;
      const status = isWorkflowStatus(bot.workflowStatus) ? bot.workflowStatus : null;
      if (!status) return;
      const waiting = Array.isArray(bot.workflowWaitingFor)
        ? (bot.workflowWaitingFor as WorkflowWaitingFor[])
        : undefined;
      const stopReason = typeof bot.workflowStopReason === "string" ? bot.workflowStopReason : undefined;
      // Permission cards send their own Allow once / Deny message. Do not
      // also broadcast the blocked workflow notice.
      if (status === "blocked" && stopReason === AUTONOMY_STOP.approval) return;
      const notice = telegramWorkflowNotice(status, waiting, stopReason);
      const requestId = deps.lineage?.forThread(threadId);
      for (const chatId of chats) {
        if (lastWorkflow.get(chatId) === status) continue;
        lastWorkflow.set(chatId, status);
        void sendSafe(chatId, notice, undefined, requestId);
      }
      if (status === "completed" || status === "paused" || status === "blocked" || status === "needs_input") {
        originByThread.delete(threadId);
      }
      return;
    }
    if (payload.kind === "message" && typeof payload.threadId === "string" && isRecord(payload.message)) {
      const chats = chatIdsFor(payload.threadId);
      if (!chats.length) return;
      const message = payload.message;
      const requestId = deps.lineage?.forThread(payload.threadId);
      if (message.kind === "text" && message.role === "bot" && typeof message.text === "string") {
        const text = telegramSafeText(message.text);
        if (text) for (const chatId of chats) void sendSafe(chatId, text, undefined, requestId);
        return;
      }
      if (message.kind === "activity" && isRecord(message.tool)) {
        const command = typeof message.tool.command === "string" ? message.tool.command : "";
        const name = typeof message.tool.name === "string" ? message.tool.name : "";
        const label = telegramSafeCommand(command || name);
        if (label) for (const chatId of chats) void sendSafe(chatId, `Progress: ${label}`, undefined, requestId);
        return;
      }
      if (message.kind === "options" && isRecord(message.card)) {
        const requestType = message.card.requestType;
        if (requestType === "secret" || requestType === "credential") {
          for (const chatId of chats) {
            void sendSafe(chatId, "Needs input — open VelarixBot to respond. Secrets are never sent over Telegram.", undefined, requestId);
          }
          return;
        }
        if (requestType === "permission") {
          return;
        }
        if (requestType === "question") {
          for (const chatId of chats) void sendSafe(chatId, telegramWorkflowNotice("needs_input"), undefined, requestId);
        }
      }
    }
  }

  return {
    publicStatus,
    applyConfig,
    handleUpdate,
    pollOnce,
    onBroadcast,
    notifyPermissionApproval,
    stop,
  };
}
