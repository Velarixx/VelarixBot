// Optional Discord chat interface on the P1 channel SPI. Token lives in
// the SecretStore. Empty allowlist denies everyone. Explicit bindings
// choose the local bot/group — Discord users cannot pick an agent.
import type { AppConfig } from "./config.ts";
import { secretStore } from "./secrets.ts";
import { redactSecrets } from "./redact-text.ts";
import type { BotsService } from "./services/bots.ts";
import type { GroupsService } from "./services/groups.ts";
import type { StartTurnOpts } from "./services/turns.ts";
import type { LineageService } from "./services/lineage.ts";
import type { DiscordConversationsRepository } from "./repositories/discord-conversations.ts";
import {
  CHANNEL_EVENTS_INHERIT_STANDING_APPROVALS,
  resolveApprovalsForChannelEvent,
  type ChannelInboundMessage,
} from "./channels/contracts.ts";
import {
  createDiscordChannelConnector,
  type DiscordChannelConnector,
  type DiscordConnectInput,
} from "./channels/discord.ts";
import {
  allowlistsEmpty,
  discordConversationKey,
  isDiscordAuthorized,
  parseAllowlists,
  parseDiscordBindings,
  parseDiscordConversationKey,
  redactDiscordToken,
  resolveDiscordBinding,
  type DiscordAllowlists,
  type DiscordBinding,
} from "./channels/discord-protocol.ts";
import {
  isWorkflowStatus,
  waitingLabel,
  workflowLabel,
  type WorkflowStatus,
  type WorkflowWaitingFor,
} from "./workflow.ts";

export const DISCORD_PUBLIC_STATUSES = ["disconnected", "connected", "error"] as const;
export type DiscordPublicStatus = (typeof DISCORD_PUBLIC_STATUSES)[number];

export interface DiscordConfigStatus {
  configured: boolean;
  enabled: boolean;
  defaultBotId?: string;
  defaultGroupId?: string;
  guildAllowlist: string[];
  channelAllowlist: string[];
  userAllowlist: string[];
  bindings: DiscordBinding[];
  status: DiscordPublicStatus;
  statusMessage: string;
  nextStep: string;
}

export const DISCORD_COPY = {
  disconnected:
    "Discord is disconnected. Paste a bot token from the Discord Developer Portal, pick an agent or group, and add an allowlist to connect.",
  connecting: "Connecting to Discord… Confirm the token and Gateway intents, then wait for Ready.",
  connected: "Discord is connected. Authorized guilds, channels, and users can message the bound agent.",
  connectedEmptyAllowlist:
    "Connected to Discord, but the allowlist is empty. Add a guild, channel, or user ID or nobody is authorized.",
  noBinding: "No agent or group is bound. Choose which VelarixBot agent or group receives Discord conversations.",
  offline:
    "VelarixBot is offline. Start the desktop app so Discord messages can be received and answered.",
  unauthorized: "You are not authorized to use this VelarixBot.",
  disabled: "Discord is disabled in VelarixBot settings.",
  busy: "This agent is already working. Wait for it to finish, or interrupt the turn in VelarixBot.",
  nextDisconnected: "Paste a Discord bot token, choose a binding, add an allowlist, then connect.",
  nextConnected: "Authorized conversations stay on the bound agent. Disconnect to drop the token immediately.",
  nextEmptyAllowlist: "Add a guild, channel, or user ID. An empty allowlist authorizes nobody.",
  nextNoBinding: "Select an agent or group in Settings. Discord users cannot pick a local agent.",
  nextError: "Check the bot token, privileged Gateway intents, and network, then reconnect.",
  nextOffline: "Start the VelarixBot desktop app, then return here to connect Discord.",
  error(detail: string): string {
    return `Discord error. ${detail} Check the bot token and Gateway connection, then reconnect.`;
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function decodeDiscordSettings(discord: AppConfig["discord"]): {
  token?: string;
  enabled: boolean;
  defaultBotId?: string;
  defaultGroupId?: string;
  guildAllowlist: string[];
  channelAllowlist: string[];
  userAllowlist: string[];
  bindings: DiscordBinding[];
} {
  const token = typeof discord?.token === "string" && discord.token.trim() ? discord.token : undefined;
  const defaultBotId =
    typeof discord?.defaultBotId === "string" && discord.defaultBotId.trim() ? discord.defaultBotId.trim() : undefined;
  const defaultGroupId =
    typeof discord?.defaultGroupId === "string" && discord.defaultGroupId.trim() ? discord.defaultGroupId.trim() : undefined;
  const lists = parseAllowlists({
    guildAllowlist: discord?.guildAllowlist,
    channelAllowlist: discord?.channelAllowlist,
    userAllowlist: discord?.userAllowlist,
  });
  return {
    ...(token ? { token } : {}),
    enabled: discord?.enabled === true,
    ...(defaultBotId ? { defaultBotId } : {}),
    ...(defaultGroupId ? { defaultGroupId } : {}),
    guildAllowlist: lists.guilds,
    channelAllowlist: lists.channels,
    userAllowlist: lists.users,
    bindings: parseDiscordBindings(discord?.bindings),
  };
}

export function discordSafeText(text: string): string {
  return redactSecrets(String(text ?? "")).slice(0, 2000);
}

export function discordWorkflowNotice(
  status: WorkflowStatus,
  waitingFor?: WorkflowWaitingFor[] | null,
  stopReason?: string | null,
): string {
  const label = workflowLabel(status, waitingFor);
  if (status === "waiting") return discordSafeText(waitingLabel(waitingFor));
  if (status === "blocked") {
    const detail = stopReason?.trim() ? ` — ${discordSafeText(stopReason)}` : "";
    return `Blocked${detail}`;
  }
  if (status === "needs_input") return "Needs input — reply here, or open VelarixBot if a secret is required.";
  if (status === "completed") return "Completed";
  if (status === "paused") return "Paused";
  return label;
}

export interface DiscordService {
  publicStatus(): DiscordConfigStatus;
  applyConfig(): void;
  connector(): DiscordChannelConnector;
  handleInbound(message: ChannelInboundMessage): Promise<void>;
  onBroadcast(payload: unknown): void;
  disconnectNow(): void;
  stop(): void;
}

export function createDiscordService(deps: {
  cfg: () => AppConfig;
  connector?: DiscordChannelConnector;
  conversations: DiscordConversationsRepository;
  bots: BotsService;
  groups: GroupsService;
  startTurn: (botId: string, text: string, opts?: StartTurnOpts) => Promise<unknown>;
  now: () => number;
  connectOpts?: () => Partial<DiscordConnectInput>;
  onStatusChange?: () => void;
  lineage?: LineageService;
}): DiscordService {
  const connector = deps.connector ?? createDiscordChannelConnector({ id: "discord" });
  let runtime: DiscordPublicStatus = "disconnected";
  let runtimeDetail = DISCORD_COPY.disconnected;
  let nextStep = DISCORD_COPY.nextDisconnected;
  const originByThread = new Map<string, string>();
  const lastWorkflow = new Map<string, string>();
  let connecting = false;

  if (CHANNEL_EVENTS_INHERIT_STANDING_APPROVALS) {
    throw new Error("discord inbound must not inherit standing approvals");
  }

  function settings() {
    return decodeDiscordSettings(deps.cfg().discord);
  }

  function lists(): DiscordAllowlists {
    const s = settings();
    return { guilds: s.guildAllowlist, channels: s.channelAllowlist, users: s.userAllowlist };
  }

  function setRuntime(status: DiscordPublicStatus, message: string, step: string): void {
    if (runtime === status && runtimeDetail === message && nextStep === step) return;
    runtime = status;
    runtimeDetail = message;
    nextStep = step;
    deps.onStatusChange?.();
  }

  function applyConnectorSettings(): void {
    const s = settings();
    connector.applySettings({
      enabled: s.enabled,
      defaultBotId: s.defaultBotId,
      defaultGroupId: s.defaultGroupId,
      guildAllowlist: s.guildAllowlist,
      channelAllowlist: s.channelAllowlist,
      userAllowlist: s.userAllowlist,
      bindings: s.bindings,
    });
  }

  function publicStatus(): DiscordConfigStatus {
    const s = settings();
    const configured = Boolean(s.token);
    if (!s.enabled || !configured) {
      return {
        configured,
        enabled: s.enabled,
        ...(s.defaultBotId ? { defaultBotId: s.defaultBotId } : {}),
        ...(s.defaultGroupId ? { defaultGroupId: s.defaultGroupId } : {}),
        guildAllowlist: s.guildAllowlist,
        channelAllowlist: s.channelAllowlist,
        userAllowlist: s.userAllowlist,
        bindings: s.bindings,
        status: "disconnected",
        statusMessage: DISCORD_COPY.disconnected,
        nextStep: DISCORD_COPY.nextDisconnected,
      };
    }
    let status = runtime;
    let statusMessage = runtimeDetail;
    let step = nextStep;
    if (connecting && status === "disconnected") {
      statusMessage = DISCORD_COPY.connecting;
      step = DISCORD_COPY.connecting;
    }
    if (status === "connected" && allowlistsEmpty(lists())) {
      statusMessage = DISCORD_COPY.connectedEmptyAllowlist;
      step = DISCORD_COPY.nextEmptyAllowlist;
    } else if (status === "connected" && !s.defaultBotId && !s.defaultGroupId && s.bindings.length === 0) {
      statusMessage = DISCORD_COPY.noBinding;
      step = DISCORD_COPY.nextNoBinding;
    }
    return {
      configured,
      enabled: s.enabled,
      ...(s.defaultBotId ? { defaultBotId: s.defaultBotId } : {}),
      ...(s.defaultGroupId ? { defaultGroupId: s.defaultGroupId } : {}),
      guildAllowlist: s.guildAllowlist,
      channelAllowlist: s.channelAllowlist,
      userAllowlist: s.userAllowlist,
      bindings: s.bindings,
      status,
      statusMessage,
      nextStep: step,
    };
  }

  function isLive(): boolean {
    const s = settings();
    return s.enabled && Boolean(s.token);
  }

  function resolveTarget(message: ChannelInboundMessage): {
    botId: string;
    groupId?: string;
    threadId: string;
    loc: { guildId?: string; channelId: string; threadId?: string };
  } | null {
    const loc = parseDiscordConversationKey(message.address.target);
    const key = discordConversationKey(loc);
    const persisted = deps.conversations.getByKey(key);
    if (persisted?.botId) {
      const bot = deps.bots.bot(persisted.botId);
      if (bot && !bot.hidden) {
        return {
          botId: bot.id,
          ...(persisted.groupId ? { groupId: persisted.groupId } : {}),
          threadId: persisted.velarixThreadId || bot.threadId,
          loc,
        };
      }
    }
    if (persisted?.groupId) {
      const group = deps.groups.get(persisted.groupId);
      const memberId = group?.memberIds.find((id) => {
        const bot = deps.bots.bot(id);
        return bot && !bot.hidden;
      });
      if (group && memberId) {
        return { botId: memberId, groupId: group.id, threadId: persisted.velarixThreadId || group.threadId, loc };
      }
    }
    const s = settings();
    const bound = resolveDiscordBinding(s.bindings, loc);
    if (bound?.botId) {
      const bot = deps.bots.bot(bound.botId);
      if (bot && !bot.hidden) return { botId: bot.id, threadId: bot.threadId, loc };
    }
    if (bound?.groupId) {
      const group = deps.groups.get(bound.groupId);
      const memberId = group?.memberIds.find((id) => {
        const bot = deps.bots.bot(id);
        return bot && !bot.hidden;
      });
      if (group && memberId) return { botId: memberId, groupId: group.id, threadId: group.threadId, loc };
    }
    if (s.defaultBotId) {
      const bot = deps.bots.bot(s.defaultBotId);
      if (bot && !bot.hidden) return { botId: bot.id, threadId: bot.threadId, loc };
    }
    if (s.defaultGroupId) {
      const group = deps.groups.get(s.defaultGroupId);
      const memberId = group?.memberIds.find((id) => {
        const bot = deps.bots.bot(id);
        return bot && !bot.hidden;
      });
      if (group && memberId) return { botId: memberId, groupId: group.id, threadId: group.threadId, loc };
    }
    return null;
  }

  async function sendSafe(addressTarget: string, text: string, replyToId?: string, requestId?: string): Promise<void> {
    if (!isLive()) return;
    const safe = discordSafeText(text);
    if (!safe) return;
    await connector.send({
      connectorId: connector.id,
      address: connector.parseAddress(addressTarget),
      text: safe,
      ...(replyToId ? { replyToId } : {}),
      ...(requestId ? { requestId } : {}),
    });
  }

  async function handleInbound(message: ChannelInboundMessage): Promise<void> {
    if (!isLive()) return;
    resolveApprovalsForChannelEvent(message);
    const loc = parseDiscordConversationKey(message.address.target);
    const identity = {
      ...(loc.guildId ? { guildId: loc.guildId } : {}),
      channelId: loc.threadId || loc.channelId,
      userId: message.sender.nativeId,
      ...(message.sender.handle ? { username: message.sender.handle } : {}),
    };
    if (!isDiscordAuthorized(lists(), identity)) {
      await sendSafe(message.address.target, DISCORD_COPY.unauthorized, message.id);
      return;
    }
    const target = resolveTarget(message);
    if (!target) {
      await sendSafe(message.address.target, DISCORD_COPY.noBinding, message.id);
      return;
    }
    deps.conversations.upsert({
      conversationKey: discordConversationKey(target.loc),
      guildId: target.loc.guildId,
      channelId: target.loc.channelId,
      threadId: target.loc.threadId,
      userId: message.sender.nativeId,
      botId: target.botId,
      groupId: target.groupId,
      velarixThreadId: target.threadId,
      now: deps.now(),
    });
    originByThread.set(target.threadId, message.address.target);
    const requestId = deps.lineage?.begin({
      source: "channel",
      sourceRef: message.id,
      botId: target.botId,
      threadId: target.threadId,
    }).requestId;
    try {
      await deps.startTurn(target.botId, message.text, {
        unattended: true,
        idempotencyKey: `channel:discord:${message.id}`,
        ...(requestId ? { requestId } : {}),
        ...(target.groupId ? { groupThreadId: target.threadId } : {}),
      });
      lastWorkflow.set(message.address.target, "working");
      await sendSafe(message.address.target, discordWorkflowNotice("working"), message.id, requestId);
    } catch (error) {
      const raw = error instanceof Error ? error.message : "could not start a turn";
      if (/already working/i.test(raw)) {
        await sendSafe(message.address.target, DISCORD_COPY.busy, message.id);
        return;
      }
      await sendSafe(message.address.target, discordSafeText(`Could not start a turn. ${raw}`), message.id);
    }
  }

  connector.onEvent((event) => {
    if (event.type === "inbound") void handleInbound(event.message);
  });

  async function start(): Promise<void> {
    const s = settings();
    if (!s.enabled || !s.token) {
      connecting = false;
      await connector.disconnect();
      setRuntime("disconnected", DISCORD_COPY.disconnected, DISCORD_COPY.nextDisconnected);
      return;
    }
    applyConnectorSettings();
    connecting = true;
    setRuntime("disconnected", DISCORD_COPY.connecting, DISCORD_COPY.connecting);
    try {
      await connector.connect({ token: s.token, ...deps.connectOpts?.() });
      connecting = false;
      if (!isLive()) {
        await connector.disconnect();
        setRuntime("disconnected", DISCORD_COPY.disconnected, DISCORD_COPY.nextDisconnected);
        return;
      }
      setRuntime("connected", DISCORD_COPY.connected, DISCORD_COPY.nextConnected);
    } catch (error) {
      connecting = false;
      const raw = error instanceof Error ? error.message : "unknown error";
      const safe = redactDiscordToken(discordSafeText(raw), s.token);
      setRuntime("error", DISCORD_COPY.error(safe), DISCORD_COPY.nextError);
    }
  }

  function stop(): void {
    connecting = false;
    void connector.disconnect();
    setRuntime("disconnected", DISCORD_COPY.disconnected, DISCORD_COPY.nextDisconnected);
  }

  function dropTokenFromStore(): void {
    secretStore().remove("discord.token");
  }

  function disconnectNow(): void {
    dropTokenFromStore();
    const cfg = deps.cfg();
    if (cfg.discord) delete cfg.discord.token;
    if (cfg.discord) cfg.discord.enabled = false;
    stop();
  }

  function applyConfig(): void {
    applyConnectorSettings();
    if (!isLive()) {
      stop();
      return;
    }
    if (connector.status().status === "connected") return;
    void start();
  }

  function targetsFor(threadId: string, botId?: string): string[] {
    const origin = originByThread.get(threadId);
    if (origin) return [origin];
    const fromThread = deps.conversations.listByThread(threadId).map((row) => row.conversationKey);
    if (fromThread.length) return fromThread;
    if (botId) return deps.conversations.listByBot(botId).map((row) => row.conversationKey);
    return [];
  }

  function onBroadcast(payload: unknown): void {
    if (!isLive() || !isRecord(payload)) return;
    if (payload.kind === "bot" && isRecord(payload.bot)) {
      const bot = payload.bot;
      const threadId = typeof bot.threadId === "string" ? bot.threadId : "";
      const botId = typeof bot.id === "string" ? bot.id : "";
      if (!threadId) return;
      const targets = targetsFor(threadId, botId);
      if (!targets.length) return;
      const status = isWorkflowStatus(bot.workflowStatus) ? bot.workflowStatus : null;
      if (!status) return;
      const waiting = Array.isArray(bot.workflowWaitingFor)
        ? (bot.workflowWaitingFor as WorkflowWaitingFor[])
        : undefined;
      const stopReason = typeof bot.workflowStopReason === "string" ? bot.workflowStopReason : undefined;
      const notice = discordWorkflowNotice(status, waiting, stopReason);
      const requestId = deps.lineage?.forThread(threadId);
      for (const target of targets) {
        if (lastWorkflow.get(target) === status) continue;
        lastWorkflow.set(target, status);
        void sendSafe(target, notice, undefined, requestId);
      }
      if (status === "completed" || status === "paused" || status === "blocked" || status === "needs_input") {
        originByThread.delete(threadId);
      }
      return;
    }
    if (payload.kind === "message" && typeof payload.threadId === "string" && isRecord(payload.message)) {
      const targets = targetsFor(payload.threadId);
      if (!targets.length) return;
      const message = payload.message;
      const requestId = deps.lineage?.forThread(payload.threadId);
      if (message.kind === "text" && message.role === "bot" && typeof message.text === "string") {
        const text = discordSafeText(message.text);
        if (text) for (const target of targets) void sendSafe(target, text, undefined, requestId);
        return;
      }
      if (message.kind === "options" && isRecord(message.card)) {
        const requestType = message.card.requestType;
        if (requestType === "secret" || requestType === "credential") {
          for (const target of targets) {
            void sendSafe(target, "Needs input — open VelarixBot to respond. Secrets are never sent over Discord.", undefined, requestId);
          }
        }
      }
    }
  }

  return {
    publicStatus,
    applyConfig,
    connector() {
      return connector;
    },
    handleInbound,
    onBroadcast,
    disconnectNow,
    stop,
  };
}
