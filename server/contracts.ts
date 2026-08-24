// Canonical harness contracts — ported from upstream
// (apps/server/src/provider/ProviderDriver.ts, Services/ProviderAdapter.ts,
// packages/contracts/src/{provider,providerInstance,providerRuntime}.ts),
// de-Effect-ed: Promises instead of Effect, listener callbacks instead of
// Stream. The shapes and names are kept so the two codebases stay mutually
// readable.

import type {
  ChannelDeliveryReceipt,
  ChannelInboundMessage,
  ChannelOutboundMessage,
  ChannelRateLimitState,
  ChannelReaction,
} from "./channels/contracts.ts";

export type DriverKind = string;
export type InstanceId = string;
export type ThreadId = string;
export type TurnId = string;

// ── model selection ────────────────────────────────────────────────────
// "Which model" is a data value carried on the request, never a service
// binding (upstream ModelSelectionWire). instanceId is the routing key.
export interface ModelSelection {
  instanceId: InstanceId;
  model: string;
  /** Per-bot reasoning effort. Omitted when the instance has no effort channel. */
  effort?: string;
}

// ── instance configuration envelope ────────────────────────────────────
// `driver` is any slug — NOT validated against known drivers; unknown
// drivers round-trip and surface as unavailable shadow snapshots so a
// config from a newer build downgrades safely.
export interface InstanceConfig {
  driver: DriverKind;
  displayName?: string;
  accentColor?: string;
  environment?: Record<string, string>;
  enabled?: boolean;
  config?: unknown;
}

export type InstanceConfigMap = Record<InstanceId, InstanceConfig>;

// ── canonical runtime events ───────────────────────────────────────────
// Subset of upstream's 49-member ProviderRuntimeEvent union — the ~12 types
// the recipe says to start with, sharing one base. `raw` carries the
// native protocol message when a consumer needs to see behind the
// normalization.
export interface RuntimeEventBase {
  eventId: string;
  provider: DriverKind;
  providerInstanceId?: InstanceId;
  threadId: ThreadId;
  createdAt: string;
  turnId?: TurnId;
  itemId?: string;
  requestId?: string;
  /** P7 request lineage — inbound → turn → tools → outbound. Distinct from
   * permission/ask `requestId` on request.opened / request.resolved. */
  lineageId?: string;
  raw?: { source: string; payload: unknown };
  // ── P1.3 durable-stream envelope ─────────────────────────────────────
  // Stamped by the event log when the event is persisted (the bus emits
  // events without them; every durable/replayed copy carries all three).
  /** Envelope version so a consumer can detect a newer producer. */
  schemaVersion?: number;
  /** The durable stream this event was sequenced on (thread id for
   * runtime events; the SSE hub uses its own "ui" stream). */
  streamId?: string;
  /** Per-stream monotonic sequence (1-based, no gaps within a stream). */
  sequence?: number;
}

/** Version of the persisted/streamed event envelope (P1.3). */
export const EVENT_SCHEMA_VERSION = 1;

export type RuntimeEvent = RuntimeEventBase &
  (
    | { type: "session.started"; sessionId: string | null; model?: string | null }
    | { type: "session.exited"; reason?: string }
    | { type: "turn.started" }
    | {
        type: "turn.completed";
        ok: boolean;
        stopReason?: string | null;
        cost?: number | null;
        denials?: string[];
      }
    | { type: "item.started"; itemType: "tool" | "reasoning"; title?: string }
    | { type: "item.updated"; itemType: "tool" | "reasoning"; tokens?: number | null }
    | { type: "item.completed"; itemType: "tool"; ok: boolean; stopReason?: string | null }
    | { type: "item.completed"; itemType: "assistant_text"; text: string }
    | { type: "content.delta"; streamKind: "assistant_text" | "reasoning_text"; delta: string }
    | {
        type: "request.opened";
        requestType: "permission" | "question" | "credential";
        tool: string;
        summary: string;
        choices?: string[];
      }
    | { type: "request.resolved"; behavior: string; source: string }
    | { type: "thread.token-usage.updated"; input: number; output: number }
    | { type: "runtime.error"; message: string }
    // Channel-connector events (Priority 1). Stream on `channel:<connectorId>`,
    // never a bot thread — standing approvals do not apply.
    | { type: "channel.inbound"; connectorId: string; message: ChannelInboundMessage }
    | { type: "channel.outbound"; connectorId: string; outboundId: string; message: ChannelOutboundMessage }
    | { type: "channel.reaction"; connectorId: string; reaction: ChannelReaction }
    | { type: "channel.receipt"; connectorId: string; receipt: ChannelDeliveryReceipt }
    | { type: "channel.rate-limit"; connectorId: string; rateLimit: ChannelRateLimitState }
  );

export type RuntimeEventListener = (event: RuntimeEvent) => void;

// ── adapter contract (upstream ProviderAdapterShape, promise-flavored) ──
// The conversation runtime every provider is flattened into. streamEvents
// becomes onEvent(listener) → unsubscribe; sessions start implicitly on
// the first turn (the agentcal per-turn-process model) with resumeCursor
// carrying the provider-native continuation (e.g. a claude session id).
export interface SendTurnInput {
  threadId: ThreadId;
  text: string;
  model?: string;
  /** Per-bot reasoning effort. Drivers without an effort channel ignore it. */
  effort?: string;
  resumeCursor?: unknown;
  /** Prior turns for transcript-replay providers (API-backed drivers). */
  transcript?: Array<{ role: "user" | "assistant"; text: string }>;
  /** Bot persona (name/title/description) as a system prompt. */
  system?: string;
  /** Per-bot integrations the driver may hand to the agent as tools. */
  integrations?: {
    /** Connected apps for this bot, via the composio-proxy stdio MCP.
     * Spawn contract is built by the harness (key in env, never argv). */
    composio?: { command: string; args: string[]; env: Record<string, string> };
    /** The bot's computer, resolved from its provider binding (P1.1).
     * `provider` is the provider KIND ("box" | "local" | "fake" | …).
     * `mcp` is the spawn contract the provider built for mounting the
     * computer tools — drivers mount it VERBATIM (secrets ride env, never
     * argv; for the local provider the daemon is spawned by Electron main,
     * the contract only points at the already-running socket). `handle` is
     * the provider-native machine reference for drivers that run ON the
     * computer (boxAgent). */
    computer?: {
      provider: string;
      mcp: { command: string; args: string[]; env: Record<string, string> } | null;
      handle?: { machineId: string };
    };
    /** Peer-agent comms: an MCP proxy (list_bots / ask_bot / delegate_bot / create_bot / update_bot / delete_bot) that
     * routes back through the harness so this bot can message other bots and
     * create, update, or remove real sidebar bots. The harness owns turns, permissions, and
     * recursion limits; the proxy only forwards. */
    agents?: { command: string; args: string[]; env: Record<string, string> };
    /** Local markdown memory: remember / recall MCP tools. Spawn contract is
     * built by the harness (token in env, never argv). */
    memory?: { command: string; args: string[]; env: Record<string, string> };
    /** Workspace CoS tools (web_search, ask_choice, routines, connect_app, …). */
    workspace?: { command: string; args: string[]; env: Record<string, string> };
  };
  cwd?: string;
  /** Local file paths from a drop/paste. Drivers must not upload them. */
  attachments?: Array<{ path: string; mime?: string }>;
  /** Per-bot override: still surface a permission card under provider full-auto. */
  requireApproval?: boolean;
  /** Per-turn env merged after driver credential stripping (approved Bitwarden secrets). */
  environment?: Record<string, string>;
}

export interface TurnStartResult {
  turnId: TurnId;
}

export interface ProviderAdapter {
  readonly provider: DriverKind;
  readonly capabilities: {
    sessionModelSwitch: "in-session" | "unsupported";
    /** True when the driver mounts turn.integrations.agents as MCP tools —
     * the harness only offers agents tooling (and prompts about it) to
     * drivers that can actually hand it to the agent. */
    agentsMcp?: boolean;
    /** True only when the driver can mount the Electron-owned local CUA MCP. */
    localComputerMcp?: boolean;
    /** True only when the driver can actually act on the bot's remote
     * computer — mounting the provider-built computer MCP tools
     * (claudeAgent, codex) or running on the machine itself (boxAgent).
     * The harness must not attach integrations.computer (or the "you have
     * a computer" prompt) to a driver without this — that prompt would be
     * a lie. */
    cloudComputer?: boolean;
  };
  sendTurn(input: SendTurnInput): Promise<TurnStartResult>;
  interruptTurn(threadId: ThreadId, turnId?: TurnId): Promise<void>;
  respondToRequest(
    threadId: ThreadId,
    requestId: string,
    decision: { behavior: "allow" | "deny" | "answer"; message?: string; always?: boolean; source?: string },
  ): Promise<void>;
  hasSession(threadId: ThreadId): boolean;
  stopAll(): Promise<void>;
  onEvent(listener: RuntimeEventListener): () => void;
}

// ── provider snapshot (upstream ServerProviderShape, reduced) ────────────
export interface ProviderSnapshot {
  state: "available" | "unavailable";
  reason?: string;
  authenticated?: boolean;
  version?: string | null;
}

// ── driver SPI (upstream ProviderDriver — a plain record, not a service) ─
// `create` owns ALL per-instance state; two create calls share nothing.
// Failures must reject, never throw synchronously — the registry downgrades
// a rejection to an unavailable shadow snapshot.
export interface ModelCatalog {
  default: string;
  options: Array<{ id: string; label: string }>;
}

export interface EffortCatalog {
  default: string;
  options: Array<{ id: string; label: string }>;
}

export interface DriverCreateInput<Config> {
  instanceId: InstanceId;
  displayName: string | undefined;
  environment: Record<string, string>;
  enabled: boolean;
  config: Config;
}

export interface ProviderInstance {
  readonly instanceId: InstanceId;
  readonly driverKind: DriverKind;
  readonly displayName: string | undefined;
  readonly enabled: boolean;
  readonly models: ModelCatalog;
  /** Present only when the driver has a real effort channel (Claude --effort, Codex turn/start). */
  readonly effort?: EffortCatalog;
  /** Bound CLI path for this instance, when the driver is CLI-backed. */
  readonly cli?: string;
  readonly adapter: ProviderAdapter;
  snapshot(): Promise<ProviderSnapshot>;
  /** Cheap one-shot text call (upstream TextGeneration) — titles, summaries. */
  generateText?(prompt: string): Promise<string>;
  dispose(): Promise<void>;
}

export interface ProviderDriver<Config = unknown> {
  readonly driverKind: DriverKind;
  readonly metadata: { displayName: string; supportsMultipleInstances?: boolean };
  /** Decode the opaque config envelope; throw on invalid (→ shadow). */
  decodeConfig(raw: unknown): Config;
  defaultConfig(): Config;
  readonly models: ModelCatalog;
  create(input: DriverCreateInput<Config>): Promise<ProviderInstance>;
}

export type AnyProviderDriver = ProviderDriver<any>;

let eventCounter = 0;
export const newEventId = () => `ev-${Date.now().toString(36)}-${(eventCounter++).toString(36)}`;
export const newId = () => crypto.randomUUID();
