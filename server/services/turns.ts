// Turn dispatch + event folding + the CoS workspace tools — the runtime
// heart of the harness, extracted from index.ts (P0.5). Behavior is the
// pre-refactor behavior; state that used to be module globals now lives in
// this service's closure and every dependency arrives through
// createTurnsService (the composition root wires it).
import { existsSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  activityOutcome,
  completedNote,
  createActivityIndex,
  rememberToolCompletion,
  releaseThreadItems,
  runningActivities,
  runningTool,
  settledTool,
  takePendingCompletion,
  trackOpenTool,
  type ActivityStatus,
} from "../activity-status.ts";
import {
  appendAudit,
  argumentPattern,
  autoResolvePermission,
  persistAllowRule,
} from "../approvals.ts";
import { clearUnattended, hopUnattended, isUnattended, markUnattended, configureUnattended } from "../unattended.ts";
import * as composio from "../composio.ts";
import { composioConfigured, composioSessionKey, ensureBotSession, sessionProxyEnv } from "../composio-sessions.ts";
import { bitwardenConfigured, fetchApprovedSecretEnv, fetchApprovedSecrets } from "../bitwarden.ts";
import type { ComputerProvider } from "../computer/provider.ts";
import { createLeaseBroker, LEASE_WAIT_DEFAULT_MS, type LeaseBroker } from "../computer/leases.ts";
import type { ComputerRegistry } from "../computer/registry.ts";
import {
  ASK_BUDGET_MS,
  COMMS_DEPTH_ERROR,
  MAX_COMMS_DEPTH,
  uniqueIds,
} from "../comms.ts";
import type { AppConfig } from "../config.ts";
import { ensureBotWorkspace, EVENTS_DIR, NATIVE_DIR } from "../config.ts";
import { newId, type ModelSelection, type RuntimeEvent } from "../contracts.ts";
import { fetchPage, webSearch } from "../web.ts";
import { turnGrounding } from "../grounding.ts";
import type { EventBus } from "../harness/bus.ts";
import type { ProviderRegistry } from "../harness/registry.ts";
import { HANDOFF_CONTINUE, HANDOFF_TITLE, classifyOpenedRequest, handoffSubtitle, isCredentialAsk } from "../handoff.ts";
import {
  deleteBotMemory,
  distillMemory,
  extractMemory,
  fleetGenerateText,
  listMemoryRows,
  turnTextFromMessages,
  memoryPrompt,
} from "../memory.ts";
import { suggestionCardsFor, suggestionItemsFromRepeatedWorkflows } from "../suggestions.ts";
import {
  agentTasks,
  openTasksForSource,
  patchAgentTask,
} from "../agent-tasks.ts";
import { classifyAssigneeFailure, createDelegatedResultsService, type DelegatedResultsService } from "./delegated-results.ts";
import { agentsCommsPrompt } from "../chief-of-staff.ts";
import { bindCommsStore, mirrorReply } from "../comms-visibility.ts";
import { discardDelegations, drainDelegations } from "../delegations.ts";
import {
  AUTONOMY_CONTINUE_PROMPT,
  AUTONOMY_STOP,
  MAX_AUTONOMY_HOPS,
  removeWaitingFor,
  upsertWaitingFor,
  type WorkflowStatus,
  type WorkflowWaitingFor,
} from "../workflow.ts";
import { createPeerQueue } from "../peer-queue.ts";
import type { Proactive } from "../proactive.ts";
import type { Repositories } from "../repositories/index.ts";
import { parseResponseOptions, responseOptionsPrompt, shouldAttachResponseOptions } from "../response-options.ts";
import { cliMissing, engineSetupCard, isMachineStateCode, isSpawnFailure, normalizeBotColor, normalizeBotName, userFacingBlock } from "../engine-setup.ts";
import { enabledSkillIds, LAST_BOT_ERROR, listenerScheduleFromArgs, mentionedBots, uniqueSkillIds, wouldEmptyWorkspace, type MausColor, type Message, type Usage } from "../store.ts";
import { deleteSkillsForBot, getSkill, saveSkill, skillSystemNote, skillsForTurn } from "../teach.ts";
import type { Broadcast } from "./events.ts";
import type { BotsService } from "./bots.ts";
import { createGroupsService, type GroupsService } from "./groups.ts";
import type { RoutinesService } from "./routines.ts";
import type { TeachService } from "./teach.ts";
import type { LaneScheduler } from "./lanes.ts";
import type { LineageService, LineageSource } from "./lineage.ts";
import type { UsageService } from "./usage.ts";

const SERVICES_DIR = dirname(fileURLToPath(import.meta.url));
export const SECRET_CARD_ANSWER = "••••";

function proxyPath(...segments: string[]): string {
  const ts = join(SERVICES_DIR, "..", ...segments);
  return existsSync(ts) ? ts : ts.replace(/\.ts$/, ".js");
}

export interface StartTurnOpts {
  commsDepth?: number;
  attachments?: Array<{ path: string; mime?: string }>;
  visited?: string[];
  groupThreadId?: string;
  /** Extra skill ids for this turn only (routine attach, `/` mention). */
  extraSkillIds?: string[];
  /** Listener (or inherited peer hop): suppress rule/flag auto-resolve. */
  unattended?: boolean;
  /** Appended to the system prompt (untrusted-event fence lives here). */
  systemNote?: string;
  /** Full-autonomy follow-up: no user bubble; the lead reviews reports and continues. */
  autonomyContinue?: boolean;
  /** Scheduler-only; startTurn ignores this. Lane wrappers peel it off. */
  idempotencyKey?: string;
  /** P7 request lineage. Minted at inbound; startTurn binds the thread to it. */
  requestId?: string;
}

export interface TurnsServiceDeps {
  cfg: AppConfig;
  registry: ProviderRegistry;
  computers: ComputerRegistry;
  bus: EventBus;
  repos: Repositories;
  bots: BotsService;
  groups?: GroupsService;
  routines(): RoutinesService;
  teach: TeachService;
  proactive: Proactive;
  broadcast: Broadcast;
  port: number;
  commsToken: string;
  now?: () => number;
  /** Machine lease broker (shared-box serialization). The composition root
   * passes the same broker to the computer routes so the suspend guard sees
   * the turns this service is running. */
  leases?: LeaseBroker;
  /** P6: notify the lane scheduler when a turn settles. */
  onIdle?: (botId: string) => void;
  /** P6: optional lane scheduler for agent (bot-to-bot) hops. */
  lanes?: () => LaneScheduler | null;
  /** P7: request lineage. Optional so existing turn tests stay unchanged. */
  lineage?: LineageService;
  /** P7: local per-provider usage totals for routed inference. */
  usage?: UsageService;
  /** P0 #150: durable delegated-result ledger. Optional so existing turn tests stay unchanged. */
  delegatedResults?: DelegatedResultsService;
}

export interface TurnsService {
  startTurn(botId: string, text: string, opts?: StartTurnOpts): Promise<{ threadId: string; messageId: string }>;
  /** ask_bot with the per-target peer queue in front (internal comms). */
  askBotQueued(
    toBotId: string,
    message: string,
    depth: number,
    opts?: { visited?: string[]; groupThreadId?: string; fromBotId?: string; unattended?: boolean },
  ): Promise<string>;
  handleWorkspaceTool(fromBotId: string, tool: string, args: Record<string, unknown>, depth: number): Promise<{ text?: string; error?: string }>;
  askUserAndWait(botId: string, input: { question: string; choices?: string[]; secret?: boolean; connectUrl?: string }): Promise<string>;
  createSidebarBot(init?: { name?: string; title?: string; description?: string; model?: string; computer?: string; color?: string }): Promise<
    NonNullable<ReturnType<BotsService["publicBot"]>>
  >;
  removeSidebarBot(id: string): Promise<{ ok: true; bot: { id: string; name: string } } | { error: string; status: number }>;
  respond(botId: string, requestId: string, body: { behavior?: unknown; message?: unknown; always?: unknown; persistScope?: unknown }): Promise<
    { ok: true } | { error: string; status: number }
  >;
  interrupt(botId: string): Promise<{ ok: true } | { error: string; status: number }>;
  defaultSelection(): Promise<ModelSelection>;
  selectionForModel(model?: string): Promise<ModelSelection>;
  lastScreenFrame(botId: string): { png: string; mime: string } | null;
  /** Idle record: count a frame from the existing screenshot stream (no second poller). */
  noteScreenshot(botId: string): void;
}

export function createTurnsService(deps: TurnsServiceDeps): TurnsService {
  const { cfg, registry, computers, bus, repos, bots, teach, proactive, broadcast, port, commsToken } = deps;
  const lineage = deps.lineage;
  const usage = deps.usage;
  const store = bots; // message + bot accessors (repository-backed)
  const groups = deps.groups ?? createGroupsService({ repos });
  const commsBus = { store: bindCommsStore(bots, groups), broadcast };
  const now = deps.now ?? (() => Date.now());
  const delegatedResults =
    deps.delegatedResults ??
    createDelegatedResultsService({
      repos,
      now,
      broadcast,
      lookupBot: (id) => {
        const bot = store.bot(id);
        return bot ? { id: bot.id, name: bot.name, color: bot.color, threadId: bot.threadId } : null;
      },
    });
  configureUnattended({
    now,
    isBusy: (id) => store.bot(id)?.busy === true,
  });

  /** Every {kind:"bot"} SSE frame goes through the publicBot allowlist. */
  const broadcastBot = (id: string) => {
    const bot = store.publicBot(id);
    if (bot) broadcast({ kind: "bot", bot });
  };

  const delegatedByThread = new Map<
    string,
    { sourceBotId: string; sourceThreadId: string; taskId?: string; channelId?: string }
  >();

  function setWorkflow(
    botId: string,
    patch: {
      workflowStatus?: WorkflowStatus;
      workflowWaitingFor?: WorkflowWaitingFor[];
      workflowStopReason?: string;
      workflowAutonomyHops?: number;
    },
  ): void {
    store.patchBot(botId, patch);
    broadcastBot(botId);
  }

  function broadcastTask(task: { id: string } | null): void {
    if (task) broadcast({ kind: "task", task });
  }

  function upsertLeadReport(
    threadId: string,
    report: NonNullable<Message["report"]>,
    message: Omit<Message, "id" | "at" | "report">,
  ): Message {
    const existing = report.taskId
      ? store
          .messagesFor(threadId)
          .find((row) => row.report?.taskId === report.taskId && row.report?.kind === report.kind)
      : undefined;
    if (existing) {
      const patched = store.patchMessage(threadId, existing.id, { ...message, report });
      if (patched) {
        broadcast({ kind: "message.patch", threadId, message: patched });
        return patched;
      }
    }
    const appended = store.appendMessage(threadId, { ...message, report });
    broadcast({ kind: "message", threadId, message: appended });
    return appended;
  }

  function delegatedContext(bot: { id: string; threadId: string }): {
    sourceBotId: string;
    sourceThreadId: string;
    taskId?: string;
    channelId?: string;
    runId?: string;
  } | null {
    const run = delegatedResults.getRunningForThread(bot.threadId) ?? delegatedResults.getPendingForThread(bot.threadId);
    if (run) {
      const live = delegatedByThread.get(bot.threadId);
      return {
        sourceBotId: run.sourceBotId,
        sourceThreadId: run.sourceThreadId,
        taskId: run.taskId,
        channelId: live?.channelId,
        runId: run.id,
      };
    }
    return delegatedByThread.get(bot.threadId) ?? null;
  }

  function bindDelegatedRun(
    bot: { id: string; threadId: string; modelSelection: { instanceId: string; model: string } },
    turnId: string,
    startedAt: number,
  ): void {
    const pending = delegatedResults.getPendingForThread(bot.threadId);
    if (!pending) return;
    const identity = delegatedResults.identityOf(pending);
    try {
      delegatedResults.bindRunning({
        identity,
        turnId,
        providerInstanceId: bot.modelSelection.instanceId,
        providerModel: bot.modelSelection.model,
        startedAt,
      });
    } catch {
      delegatedResults.bindRunning({
        identity,
        turnId: `${pending.id}:${turnId}`,
        providerInstanceId: bot.modelSelection.instanceId,
        providerModel: bot.modelSelection.model,
        startedAt,
      });
    }
  }

  function progressTextFor(run: NonNullable<ReturnType<DelegatedResultsService["get"]>>): string {
    if (!run.progressJson) return "";
    try {
      const parsed = JSON.parse(run.progressJson) as { text?: unknown };
      return typeof parsed.text === "string" ? parsed.text : "";
    } catch {
      return "";
    }
  }

  function finalizeBoundRun(
    peer: { id: string; threadId: string; name: string; color?: MausColor; modelSelection?: { instanceId: string; model: string } },
    outcome: { ok: boolean; text?: string; detail?: string },
  ): boolean {
    let run = delegatedResults.getRunningForThread(peer.threadId);
    if (!run) {
      const pending = delegatedResults.getPendingForThread(peer.threadId);
      if (!pending) return false;
      const bot = store.bot(peer.id);
      const startedAt = now();
      try {
        run = delegatedResults.bindRunning({
          identity: delegatedResults.identityOf(pending),
          turnId: `seal:${pending.id}`,
          providerInstanceId: bot?.modelSelection.instanceId ?? "unknown",
          providerModel: bot?.modelSelection.model ?? "unknown",
          startedAt,
        });
      } catch {
        return false;
      }
    }
    const classified = outcome.ok
      ? { outcome: "completed" as const, failureCode: undefined }
      : classifyAssigneeFailure(outcome.detail);
    const text = (outcome.text ?? "").trim() || progressTextFor(run);
    delegatedResults.finalize({
      identity: delegatedResults.identityOf(run),
      result: {
        text,
        outcome: classified.outcome,
        ...(classified.failureCode ? { failureCode: classified.failureCode } : {}),
      },
      now: now(),
      workerName: peer.name,
      workerColor: peer.color,
    });
    delegatedResults.pumpDue(now());
    return true;
  }

  function waitingFromOpenTasks(sourceThreadId: string): WorkflowWaitingFor[] {
    const seen = new Set<string>();
    const out: WorkflowWaitingFor[] = [];
    for (const task of openTasksForSource(sourceThreadId)) {
      if (seen.has(task.assigneeBotId)) continue;
      seen.add(task.assigneeBotId);
      out.push({ botId: task.assigneeBotId, name: store.bot(task.assigneeBotId)?.name ?? task.fromName });
    }
    return out;
  }

  function maybeAutonomyContinue(leadId: string): void {
    const lead = store.bot(leadId);
    if (!lead || lead.busy) return;
    if (isUnattended(lead.id)) {
      setWorkflow(lead.id, {
        workflowStatus: "completed",
        workflowWaitingFor: [],
        workflowStopReason: AUTONOMY_STOP.off,
      });
      return;
    }
    if (lead.fullAutonomy !== true) {
      setWorkflow(lead.id, {
        workflowStatus: "completed",
        workflowWaitingFor: [],
        workflowStopReason: AUTONOMY_STOP.off,
      });
      return;
    }
    const hops = lead.workflowAutonomyHops ?? 0;
    if (hops >= MAX_AUTONOMY_HOPS) {
      setWorkflow(lead.id, {
        workflowStatus: "paused",
        workflowWaitingFor: [],
        workflowStopReason: AUTONOMY_STOP.boundary,
      });
      return;
    }
    setWorkflow(lead.id, {
      workflowStatus: "working",
      workflowWaitingFor: [],
      workflowStopReason: undefined,
      workflowAutonomyHops: hops + 1,
    });
    void startTurn(lead.id, AUTONOMY_CONTINUE_PROMPT, { autonomyContinue: true, commsDepth: 0 }).catch(() => {
      setWorkflow(lead.id, {
        workflowStatus: "blocked",
        workflowStopReason: AUTONOMY_STOP.blocked("could not continue the workflow"),
      });
    });
  }

  function settleDelegatedPeer(
    peer: { id: string; threadId: string; name: string; color?: MausColor },
    outcome: { ok: boolean; text?: string; detail?: string },
  ): void {
    const ctx = delegatedContext(peer);
    if (!ctx) return;
    delegatedByThread.delete(peer.threadId);
    const sealed = finalizeBoundRun(peer, outcome);
    const lead = store.botByThread(ctx.sourceThreadId) ?? store.bot(ctx.sourceBotId);
    if (!lead) return;
    if (ctx.taskId && !sealed) {
      broadcastTask(patchAgentTask(ctx.taskId, outcome.ok ? { state: "completed", result: (outcome.text ?? "").trim() } : { state: "blocked", blocker: outcome.detail }));
    } else if (ctx.taskId) {
      const task = agentTasks().get(ctx.taskId);
      if (task) broadcastTask(task);
    }
    if (!outcome.ok) {
      setWorkflow(lead.id, {
        workflowStatus: "blocked",
        workflowWaitingFor: removeWaitingFor(lead.workflowWaitingFor, peer.id),
        workflowStopReason: AUTONOMY_STOP.peerBlocked(peer.name, outcome.detail),
      });
      return;
    }
    const waiting = waitingFromOpenTasks(lead.threadId);
    if (waiting.length) {
      setWorkflow(lead.id, {
        workflowStatus: "waiting",
        workflowWaitingFor: waiting,
        workflowStopReason: undefined,
      });
      return;
    }
    maybeAutonomyContinue(lead.id);
  }

  /** The provider a bot.computer binding resolves to — null for off/unbound
   * (including bindings whose provider was removed from config). */
  function boundProvider(computer: string | undefined): ComputerProvider | null {
    const binding = computers.resolveBinding(computer);
    return binding && binding !== "off" ? computers.get(binding) : null;
  }

  // ── machine leases (shared-box serialization, 3.4/D3) ─────────────────
  // One turn per machine: acquired at the dispatch site below for EVERY
  // machine-backed remote computer turn, keyed vendor-blind as
  // `<providerKind>:<machineId>`. In per-bot mode every bot has its own
  // machine, so keys never contend and behavior is unchanged; in shared
  // mode every bot resolves to the one shared machine and turns serialize
  // FIFO. Panel-driven exec/join never take the lease.
  const leases = deps.leases ?? createLeaseBroker();
  const leaseKeyByBot = new Map<string, string>();

  /** cfg.box.leaseWaitMs (D3, strict-decoded at provider create; read
   * tolerantly here so a bad value degrades to the default, never a hang). */
  function leaseWaitMs(): number {
    const raw = cfg.box?.leaseWaitMs;
    return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : LEASE_WAIT_DEFAULT_MS;
  }

  function releaseComputerLease(botId: string): void {
    const key = leaseKeyByBot.get(botId);
    if (!key) return;
    leaseKeyByBot.delete(botId);
    leases.release(key, botId);
  }

  const agentsProxyPath = proxyPath("drivers", "agents-proxy.ts");
  const composioProxyPath = proxyPath("composio-proxy.ts");
  const memoryProxyPath = proxyPath("memory-proxy.ts");
  const workspaceProxyPath = proxyPath("workspace-proxy.ts");
  // in the packaged app process.execPath is Electron — run the proxy as node
  const AGENTS_NODE_FLAG = { ELECTRON_RUN_AS_NODE: "1" };

  function agentsIntegration(botId: string, depth: number, visited: string[] = [], groupThreadId?: string) {
    return {
      command: process.execPath,
      args: [agentsProxyPath],
      env: {
        ...AGENTS_NODE_FLAG,
        OMB_HARNESS_URL: `http://127.0.0.1:${port}`,
        OMB_BOT_ID: botId,
        OMB_COMMS_TOKEN: commsToken,
        OMB_TURN_DEPTH: String(depth),
        OMB_VISITED: visited.join(","),
        ...(groupThreadId ? { OMB_GROUP_THREAD_ID: groupThreadId } : {}),
      },
    };
  }

  function composioIntegration(sessionEnv: Record<string, string>) {
    return {
      command: process.execPath,
      args: [composioProxyPath],
      env: {
        ...AGENTS_NODE_FLAG,
        ...sessionEnv,
      },
    };
  }

  function memoryIntegration(botId: string) {
    return {
      command: process.execPath,
      args: [memoryProxyPath],
      env: {
        ...AGENTS_NODE_FLAG,
        OMB_HARNESS_URL: `http://127.0.0.1:${port}`,
        OMB_BOT_ID: botId,
        OMB_COMMS_TOKEN: commsToken,
      },
    };
  }

  function workspaceIntegration(botId: string, depth: number) {
    return {
      command: process.execPath,
      args: [workspaceProxyPath],
      env: {
        ...AGENTS_NODE_FLAG,
        OMB_HARNESS_URL: `http://127.0.0.1:${port}`,
        OMB_BOT_ID: botId,
        OMB_COMMS_TOKEN: commsToken,
        OMB_TURN_DEPTH: String(depth),
      },
    };
  }

  // ── ask a peer bot and wait for its reply ─────────────────────────────
  function askBotAndWait(
    targetBotId: string,
    message: string,
    depth: number,
    opts?: { visited?: string[]; groupThreadId?: string; fromBotId?: string; unattended?: boolean },
  ): Promise<string> {
    const target = store.bot(targetBotId);
    if (!target) return Promise.resolve("(no such bot)");
    const threadId = target.threadId;
    const groupThreadId = opts?.groupThreadId;
    const asker = opts?.fromBotId ? store.bot(opts.fromBotId) : null;
    if (asker) {
      setWorkflow(asker.id, {
        workflowStatus: "waiting",
        workflowWaitingFor: upsertWaitingFor(asker.workflowWaitingFor, { botId: target.id, name: target.name }),
        workflowStopReason: undefined,
      });
    }
    return new Promise((resolve) => {
      let text = "";
      let done = false;
      const finish = (out: string) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        unsub();
        if (asker) {
          const latest = store.bot(asker.id);
          const waiting = removeWaitingFor(latest?.workflowWaitingFor, target.id);
          setWorkflow(asker.id, {
            workflowStatus: waiting.length ? "waiting" : "working",
            workflowWaitingFor: waiting,
          });
        }
        if (groupThreadId && out && !out.startsWith("(couldn't start") && !out.startsWith("(timed out") && !out.startsWith("(no such")) {
          const note = store.appendMessage(groupThreadId, {
            role: "bot",
            kind: "text",
            text: `@${target.name}: ${out}`,
            from: { botId: target.id, name: target.name, color: target.color },
            report: { kind: "completion", fromBotId: target.id },
          });
          broadcast({ kind: "message", threadId: groupThreadId, message: note });
          const owner = store.botByThread(groupThreadId);
          if (owner) {
            store.patchBot(owner.id, { unread: true });
            broadcastBot(owner.id);
            broadcast({ kind: "peer.reply", botId: owner.id, fromBotId: target.id, fromName: target.name });
          }
        }
        resolve(out);
      };
      const unsub = bus.subscribe((e: RuntimeEvent) => {
        if (e.threadId !== threadId) return;
        if (e.type === "item.completed" && e.itemType === "assistant_text") {
          const reply = parseResponseOptions(e.text);
          if (reply.text) text += (text ? "\n" : "") + reply.text;
        } else if (e.type === "turn.completed") {
          finish(text || "(the bot finished without a text reply)");
        }
      });
      const timer = setTimeout(() => finish(text || "(timed out waiting for the bot to reply)"), ASK_BUDGET_MS);
      service
        .startTurn(targetBotId, message, {
          commsDepth: depth + 1,
          visited: uniqueIds([...(opts?.visited ?? []), targetBotId]),
          groupThreadId,
          // snapshot at hop time (ask_bot / group thread / queue drain)
          unattended: hopUnattended(opts),
          ...(lineage?.forThread(asker?.threadId ?? "") ? { requestId: lineage.forThread(asker!.threadId) } : {}),
        })
        .catch((err) => finish(`(couldn't start that bot: ${err instanceof Error ? err.message : String(err)})`));
    });
  }

  // default selection for new bots: first available instance, codex preferred over claude
  async function defaultSelection(): Promise<ModelSelection> {
    const described = await registry.describe();
    const available = described.filter((d) => d.snapshot.state === "available");
    const pick = available.find((d) => d.driverKind === "codex") ?? available.find((d) => d.driverKind === "claudeAgent") ?? available[0] ?? described[0];
    return { instanceId: pick?.instanceId ?? "claude", model: pick?.models.default || "claude-sonnet-5" };
  }

  async function selectionForModel(model?: string): Promise<ModelSelection> {
    const selection = await defaultSelection();
    const slug = model?.trim();
    if (!slug) return selection;
    const described = await registry.describe();
    const available = described.filter((d) => d.snapshot.state === "available");
    const pool = available.length ? available : described;
    const hit =
      pool.find((d) => d.models.options.some((o) => o.id === slug)) ??
      pool.find((d) => d.models.default === slug) ??
      pool.find((d) => d.instanceId === selection.instanceId) ??
      pool[0];
    return { instanceId: hit?.instanceId ?? selection.instanceId, model: slug };
  }

  // ── user asks (ask_choice / ask_secret / connect_app cards) ───────────
  const pendingAskByRequest = new Map<string, { botId: string; tool: string; summary: string; requestType: string }>();
  const userAskWaiters = new Map<
    string,
    { resolve: (text: string) => void; reject: (error: Error) => void; secret: boolean; botId: string }
  >();

  function settleUserAsk(requestId: string, text: string): boolean {
    const waiter = userAskWaiters.get(requestId);
    if (!waiter) return false;
    userAskWaiters.delete(requestId);
    waiter.resolve(text);
    return true;
  }

  function askUserAndWait(
    botId: string,
    input: { question: string; choices?: string[]; secret?: boolean; connectUrl?: string },
  ): Promise<string> {
    const bot = store.bot(botId);
    if (!bot) return Promise.reject(new Error("no such bot"));
    const requestId = newId();
    const secret = input.secret === true;
    const message = store.appendMessage(bot.threadId, {
      role: "bot",
      kind: "options",
      card: {
        title: secret ? "Secret needed" : input.connectUrl ? "Connect an app" : "Your bot has a question",
        subtitle: input.question,
        options: input.connectUrl ? ["Done"] : (input.choices ?? []).filter(Boolean).slice(0, 5),
        requestId,
        requestType: secret ? "secret" : "question",
        ...(input.connectUrl ? { connectUrl: input.connectUrl } : {}),
      },
    });
    broadcast({ kind: "message", threadId: bot.threadId, message });
    store.patchBot(bot.id, { state: "NEEDS_INPUT" });
    proactive.noteState(bot.id, "NEEDS_INPUT");
    broadcastBot(bot.id);
    pendingAskByRequest.set(requestId, {
      botId: bot.id,
      tool: secret ? "ask_secret" : input.connectUrl ? "connect_app" : "ask_choice",
      summary: input.question,
      requestType: secret ? "secret" : "question",
    });
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!userAskWaiters.delete(requestId)) return;
        reject(new Error("timed out waiting for the user"));
      }, ASK_BUDGET_MS);
      timer.unref?.();
      userAskWaiters.set(requestId, {
        resolve: (text) => {
          clearTimeout(timer);
          resolve(text);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
        secret,
        botId: bot.id,
      });
    });
  }

  const idleListeners = new Set<(botId: string) => void>();
  function notifyIdle(botId: string) {
    deps.onIdle?.(botId);
    for (const listener of [...idleListeners]) listener(botId);
  }
  const peerQueue = createPeerQueue({
    isBusy: (botId) => store.bot(botId)?.busy === true,
    onIdle: (listener) => {
      idleListeners.add(listener);
      return () => idleListeners.delete(listener);
    },
    budgetMs: ASK_BUDGET_MS,
  });

  // ── sidebar bot lifecycle (create/remove fan out on SSE) ──────────────
  async function createSidebarBot(init?: { name?: string; title?: string; description?: string; model?: string; computer?: string; color?: string }) {
    const named = typeof init?.name === "string" ? normalizeBotName(init.name) : null;
    if (named && !named.ok) {
      throw Object.assign(new Error(named.error), { status: 400 });
    }
    const color = init?.color !== undefined ? normalizeBotColor(init.color) : null;
    if (init?.color !== undefined && !color) {
      throw Object.assign(new Error("color must be a known palette name"), { status: 400 });
    }
    const bot = bots.createBot();
    // the requested binding must resolve to a registered provider — when it
    // doesn't (e.g. "cloud" with Box removed from config), the bot simply
    // stays off instead of failing creation
    const computerBinding = init?.computer ? computers.resolveBinding(init.computer) : null;
    bots.patchBot(bot.id, {
      modelSelection: await selectionForModel(init?.model),
      ...(named?.ok ? { name: named.name } : {}),
      ...(typeof init?.title === "string" ? { title: init.title } : {}),
      ...(typeof init?.description === "string" ? { description: init.description } : {}),
      ...(computerBinding && computerBinding !== "off" ? { computer: computerBinding } : {}),
      ...(color ? { color } : {}),
    });
    const full = bots.publicBot(bot.id)!;
    broadcast({ kind: "bot.added", bot: full });
    return full;
  }

  async function removeSidebarBot(id: string): Promise<{ ok: true; bot: { id: string; name: string } } | { error: string; status: number }> {
    const bot = store.bot(id);
    if (!bot) return { error: "no such bot", status: 404 };
    if (wouldEmptyWorkspace(bots.count())) return { error: LAST_BOT_ERROR, status: 409 };
    await registry.get(bot.modelSelection.instanceId)?.adapter.interruptTurn(bot.threadId).catch(() => {});
    stopScreenPoller(bot.id);
    teach.release(bot.id);
    deleteBotMemory(bot.id);
    const remaining = bots.bots().filter((b) => b.id !== bot.id);
    const remainingIds = new Set(remaining.map((b) => b.id));
    const stillReferenced = new Set<string>();
    for (const other of remaining) {
      for (const id of enabledSkillIds(other)) stillReferenced.add(id);
    }
    for (const routine of deps.routines().routines()) {
      if (!remainingIds.has(routine.botId)) continue;
      if (routine.skillId) stillReferenced.add(routine.skillId);
    }
    deleteSkillsForBot(bot.id, stillReferenced);
    bots.deleteBot(bot.id);
    for (const dir of [EVENTS_DIR, NATIVE_DIR]) {
      try {
        unlinkSync(join(dir, `${bot.threadId}.ndjson`));
      } catch {}
    }
    broadcast({ kind: "bot.deleted", botId: bot.id });
    return { ok: true, bot: { id: bot.id, name: bot.name } };
  }

  const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;

  async function handleWorkspaceTool(
    fromBotId: string,
    tool: string,
    args: Record<string, unknown>,
    depth: number,
  ): Promise<{ text?: string; error?: string }> {
    const bot = store.bot(fromBotId);
    if (!bot) return { error: "no such bot" };
    if (depth >= MAX_COMMS_DEPTH && (tool === "ask_choice" || tool === "ask_secret" || tool === "create_routine")) {
      return { error: COMMS_DEPTH_ERROR };
    }
    try {
      if (tool === "web_search") {
        return { text: await webSearch(String(args.query ?? "")) };
      }
      if (tool === "fetch_page") {
        return { text: await fetchPage(String(args.url ?? "")) };
      }
      if (tool === "ask_choice") {
        const question = String(args.question ?? "").trim();
        const choices = (Array.isArray(args.choices) ? args.choices : []).map((c) => String(c).trim()).filter(Boolean).slice(0, 5);
        if (!question || choices.length < 2) return { error: "ask_choice needs a question and at least two choices." };
        const answer = await askUserAndWait(fromBotId, { question, choices });
        return { text: answer };
      }
      if (tool === "ask_secret") {
        const prompt = String(args.prompt ?? "").trim();
        if (!prompt) return { error: "ask_secret needs a prompt." };
        const value = await askUserAndWait(fromBotId, { question: prompt, secret: true });
        return { text: value };
      }
      if (tool === "create_routine") {
        const name = String(args.name ?? "").trim();
        const prompt = String(args.prompt ?? "").trim();
        if (!name || !prompt) return { error: "create_routine needs name and prompt." };
        const listener = String(args.listener ?? "").trim().toLowerCase();
        const everyMinutes = Number(args.every_minutes);
        const time = String(args.time ?? "").trim().slice(0, 5);
        let schedule: Parameters<RoutinesService["createRoutine"]>[0]["schedule"];
        if (listener === "github" || listener === "slack" || listener === "discord") {
          const every = Number.isFinite(everyMinutes) && everyMinutes > 0 ? everyMinutes : 15;
          if (listener === "slack") {
            const status = composioConfigured(cfg)
              ? await composio.connectionStatus(cfg, ["slack"], fromBotId).catch(() => ({ slack: { connected: false } }))
              : { slack: { connected: false } };
            if (!status.slack?.connected) {
              return {
                error: "slack is not connected. Call connect_app with slug slack first. Never ask the user to paste a token in chat.",
              };
            }
          }
          const parsed = listenerScheduleFromArgs(listener, args, every);
          if ("error" in parsed) return { error: `create_routine ${parsed.error}` };
          schedule = parsed.schedule;
        } else if (Number.isFinite(everyMinutes) && everyMinutes > 0) {
          schedule = { kind: "interval", everyMinutes };
        } else if (time) {
          schedule = args.every_day === true ? { kind: "daily", time } : { kind: "weekdays", time };
        } else {
          return { error: "create_routine needs time (HH:MM), every_minutes, or listener=github|slack|discord." };
        }
        const skillId = String(args.skill_id ?? "").trim();
        const routine = deps.routines().createRoutine({
          botId: fromBotId,
          name,
          prompt,
          schedule,
          ...(skillId ? { skillId } : {}),
        });
        broadcast({ kind: "routine", routine });
        return {
          text: `Created routine ${routine.name} (id: ${routine.id}, ${routine.schedule.kind}${routine.schedule.kind === "listener" ? ` ${routine.schedule.source}` : ""}). It runs while the local harness service is running.`,
        };
      }
      if (tool === "save_skill") {
        const name = String(args.name ?? "").trim();
        const steps = String(args.steps ?? "").trim();
        if (!name || !steps) return { error: "save_skill needs name and steps." };
        const skill = saveSkill({ name, botId: fromBotId, markdown: steps });
        const current = enabledSkillIds(bot);
        bots.patchBot(fromBotId, { enabledSkills: uniqueSkillIds([...current, skill.id]) });
        broadcastBot(fromBotId);
        return { text: `Saved skill ${skill.name} (id: ${skill.id}). Run it with run_skill using that id.` };
      }
      if (tool === "run_skill") {
        const skillId = String(args.skill_id ?? "").trim();
        const skill = getSkill(skillId);
        if (!skill) return { error: "no such skill" };
        return { text: `Follow these saved steps now:\n\n${skill.markdown}` };
      }
      if (tool === "attach_to_chat") {
        const kind = String(args.kind ?? "").trim();
        const provider = boundProvider(bot.computer);
        if (kind === "screenshot") {
          const polled = screenPollers.get(fromBotId)?.last;
          const shot =
            polled ??
            (provider?.capabilities.screenshot
              ? await provider
                  .screenshot(fromBotId)
                  .then((s) => ({ png: s.png, mime: s.format === "jpeg" ? ("image/jpeg" as const) : ("image/png" as const) }))
              : null);
          if (!shot) return { error: "no screenshot available — turn this bot's computer on first." };
          const message = store.appendMessage(bot.threadId, { role: "bot", kind: "screen", png: shot.png, mime: shot.mime });
          broadcast({ kind: "message", threadId: bot.threadId, message });
          return { text: "Attached the current computer screenshot to this chat." };
        }
        if (kind === "file") {
          const filePath = String(args.path ?? "").trim();
          if (!filePath) return { error: "attach_to_chat file needs path." };
          if (!provider?.capabilities.files) {
            return { error: "this bot's computer cannot share files — give it a cloud computer first." };
          }
          const read = await provider.readFile(fromBotId, filePath);
          if (IMAGE_EXT.test(filePath)) {
            const message = store.appendMessage(bot.threadId, {
              role: "bot",
              kind: "screen",
              png: read.content,
              mime: filePath.toLowerCase().endsWith(".jpg") || filePath.toLowerCase().endsWith(".jpeg") ? "image/jpeg" : "image/png",
            });
            broadcast({ kind: "message", threadId: bot.threadId, message });
            return { text: `Attached ${filePath} to this chat.` };
          }
          const decoded = Buffer.from(read.content, "base64").toString("utf8").slice(0, 8_000);
          const message = store.appendMessage(bot.threadId, {
            role: "bot",
            kind: "text",
            text: `File from computer (${filePath}):\n${decoded}`,
          });
          broadcast({ kind: "message", threadId: bot.threadId, message });
          return { text: `Attached text from ${filePath} to this chat.` };
        }
        return { error: "attach_to_chat kind must be screenshot or file." };
      }
      if (tool === "list_approved_secrets") {
        if (!bitwardenConfigured(cfg)) {
          return {
            error: "Bitwarden Secrets Manager is not connected. The user must add a machine-account access token in App Settings. Never ask them to paste a token in chat.",
          };
        }
        const approved = await fetchApprovedSecrets(cfg, bot);
        const listed = approved.map((secret) => ({ id: secret.id, key: secret.key, ...(secret.projectId ? { projectId: secret.projectId } : {}) }));
        return {
          text: listed.length
            ? `Approved secrets for this bot (names only): ${JSON.stringify(listed)}`
            : "No Bitwarden secrets are approved for this bot. Default is none — the user must allow specific secret or project ids in Bot Settings.",
        };
      }
      if (tool === "get_approved_secret") {
        const id = String(args.id ?? args.secret_id ?? "").trim();
        const key = String(args.key ?? "").trim();
        if (!id && !key) return { error: "get_approved_secret needs id or key." };
        if (!bitwardenConfigured(cfg)) {
          return {
            error: "Bitwarden Secrets Manager is not connected. The user must add a machine-account access token in App Settings. Never ask them to paste a token in chat.",
          };
        }
        const approved = await fetchApprovedSecrets(cfg, bot);
        const hit = approved.find((secret) => (id && secret.id === id) || (key && secret.key === key));
        if (!hit) return { error: "that secret is not approved for this bot." };
        return { text: hit.value };
      }
      if (tool === "connect_app") {
        const slug = String(args.slug ?? "").trim().toLowerCase();
        if (!slug) return { error: "connect_app needs a catalog slug (e.g. github)." };
        if (!composioConfigured(cfg)) {
          return {
            error:
              "Composio is not configured. The user must add a Composio API key in App Settings. Never ask them to paste a token in chat.",
          };
        }
        const auth = await composio.authorizeService(cfg, slug, fromBotId);
        const url = typeof auth?.url === "string" ? auth.url : "";
        if (!url) return { error: `could not start connect for ${slug}` };
        const enabled = Array.from(new Set([...(bot.enabledApps ?? []), slug]));
        bots.patchBot(fromBotId, { enabledApps: enabled });
        broadcastBot(fromBotId);
        const answer = await askUserAndWait(fromBotId, {
          question: `Connect ${slug} in the browser, then come back here.`,
          connectUrl: url,
        });
        return { text: `Connect flow for ${slug} finished (${answer}). Tools for that app mount on the next turn.` };
      }
      return { error: `unknown workspace tool ${tool}` };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (tool === "ask_secret" || tool === "get_approved_secret" || /token|secret|password/i.test(message)) {
        return { error: "couldn't complete that request" };
      }
      return { error: message };
    }
  }

  // ── server-side event folding (upstream's ingestion worker, miniature) ──
  // The canonical stream is the source of truth; the persisted transcript
  // and every client view are projections of it.
  const activityIndex = createActivityIndex();
  const askMessageByRequest = new Map<string, string>(); // requestId -> messageId
  const turnUsage = new Map<string, Usage>();
  const responseOptionsByTurn = new Map<string, string[]>();
  /** Last runtime.error text for this thread. turn.completed only has
   * stopReason (often "spawn_error") and used to overwrite the concrete
   * spawn detail with the generic fallback. */
  const lastRuntimeMessage = new Map<string, string>();

  function settleRunningActivities(threadId: string, status: ActivityStatus) {
    releaseThreadItems(activityIndex, threadId);
    for (const { id, tool } of runningActivities(store.messagesFor(threadId))) {
      const patched = store.patchMessage(threadId, id, { tool: settledTool(tool, status) });
      if (patched) broadcast({ kind: "message.patch", threadId, message: patched });
    }
  }

  function maybeAppendSetupCard(threadId: string, blocked: { stateCode: string; stateDetail: string }) {
    if (
      blocked.stateCode !== "spawn_error" &&
      blocked.stateCode !== "no_engines" &&
      blocked.stateCode !== "engine_unavailable" &&
      blocked.stateCode !== "auth_required"
    ) {
      return;
    }
    const already = store
      .messagesFor(threadId)
      .some((m) => m.card?.requestType === "setup" && !m.card.dismissed && !m.card.answered);
    if (already) return;
    const message = store.appendMessage(threadId, {
      role: "bot",
      kind: "options",
      card: engineSetupCard({
        reason: blocked.stateDetail,
        offerSwitch: blocked.stateCode !== "no_engines",
        zeroEngines: blocked.stateCode === "no_engines",
        authRequired: blocked.stateCode === "auth_required",
      }),
    });
    broadcast({ kind: "message", threadId, message });
  }

  function lineageSourceFor(opts?: StartTurnOpts): LineageSource {
    if ((opts?.commsDepth ?? 0) > 0) return "agent";
    if (opts?.unattended) return "routine";
    return "user";
  }

  function requestIdForEvent(event: RuntimeEvent): string | undefined {
    if (event.lineageId) return event.lineageId;
    return lineage?.forThread(event.threadId);
  }

  bus.subscribe((event: RuntimeEvent) => {
    const requestId = requestIdForEvent(event);
    const stamped = requestId && !event.lineageId ? { ...event, lineageId: requestId } : event;
    broadcast({ kind: "runtime", event: stamped, ...(requestId ? { requestId } : {}) });
    if (requestId && lineage) {
      if (event.type === "turn.started" && event.turnId) lineage.noteTurn(requestId, event.turnId);
      if (event.type === "item.started" && event.itemType === "tool") {
        lineage.noteTool(requestId, event.itemId, event.title);
      }
      if (event.type === "runtime.error" && event.message) lineage.noteError(requestId, event.message);
      if (event.type === "turn.completed" && !event.ok) {
        lineage.noteError(requestId, event.stopReason ?? "turn failed");
      }
    }
    const bot = store.botByThread(event.threadId);
    if (!bot) return;

    const pushMessage = (m: Omit<Message, "id" | "at">) => {
      const message = store.appendMessage(event.threadId, m);
      broadcast({ kind: "message", threadId: event.threadId, message });
      return message;
    };

    switch (event.type) {
      case "session.started":
        if (event.sessionId && event.providerInstanceId) {
          bots.setResumeCursor(bot.id, event.providerInstanceId, event.sessionId);
        }
        break;
      case "turn.started":
        if (event.turnId) turnUsage.delete(event.turnId);
        lastRuntimeMessage.delete(event.threadId);
        if (event.turnId) bindDelegatedRun(bot, event.turnId, now());
        bots.patchBot(bot.id, { busy: true, state: "RUNNING", stateDetail: undefined, stateCode: undefined });
        proactive.noteState(bot.id, "RUNNING");
        broadcastBot(bot.id);
        break;
      case "thread.token-usage.updated":
        if (event.turnId) turnUsage.set(event.turnId, { input: event.input, output: event.output, cost: null });
        break;
      case "item.completed":
        if (event.itemType === "assistant_text") {
          const reply = parseResponseOptions(event.text);
          if (reply.text) pushMessage({ role: "bot", kind: "text", text: reply.text });
          const run = delegatedResults.getRunningForThread(event.threadId);
          if (run && reply.text) {
            const prior = progressTextFor(run);
            const next = prior ? `${prior}\n${reply.text}` : reply.text;
            try {
              delegatedResults.recordProgress({ identity: delegatedResults.identityOf(run), text: next, now: now() });
            } catch {
              /* late or duplicate progress is ignored */
            }
          }
          if (event.turnId && shouldAttachResponseOptions(event.provider) && reply.options.length >= 2) {
            responseOptionsByTurn.set(event.turnId, reply.options);
          }
        } else if (event.itemType === "tool" && event.itemId) {
          const outcome = activityOutcome(event.ok, event.stopReason);
          const messageId = rememberToolCompletion(activityIndex, event.threadId, event.itemId, outcome);
          if (messageId) {
            const existing = store.messagesFor(event.threadId).find((m) => m.id === messageId);
            const patched = store.patchMessage(event.threadId, messageId, {
              tool: settledTool(existing?.tool, outcome.status),
            });
            if (patched) broadcast({ kind: "message.patch", threadId: event.threadId, message: patched });
          }
          // the bot just finished acting — refresh its screen preview now
          pokeScreenPoller(bot.id);
        }
        break;
      case "item.started":
        if (event.itemType === "tool") {
          const pending = takePendingCompletion(activityIndex, event.threadId, event.itemId);
          const base = runningTool(event.title ?? "tool");
          const tool = pending ? settledTool(base, pending.status) : base;
          const message = pushMessage({ role: "bot", kind: "activity", tool });
          if (!pending) trackOpenTool(activityIndex, event.threadId, event.itemId, message.id);
        }
        break;
      case "request.opened": {
        if (event.requestId) {
          pendingAskByRequest.set(event.requestId, {
            botId: bot.id,
            tool: event.tool,
            summary: event.summary,
            requestType: event.requestType,
          });
        }
        if (event.requestType === "permission" && event.requestId && !isCredentialAsk(event.requestType, event.tool, event.summary)) {
          const auto = autoResolvePermission(bot, event.tool, event.summary, { unattended: isUnattended(bot.id) });
          if (auto) {
            const instance = registry.get(bot.modelSelection.instanceId);
            if (instance) {
              void instance.adapter
                .respondToRequest(event.threadId, event.requestId, { behavior: auto.behavior, source: auto.source })
                .catch(() => {});
              break;
            }
          }
        }
        const permission = event.requestType === "permission";
        const opened = classifyOpenedRequest(event.requestType, event.tool, event.summary, event.choices);
        const credential = opened.requestType === "credential";
        const message = pushMessage({
          role: "bot",
          kind: "options",
          card: {
            title: credential ? HANDOFF_TITLE : permission && !credential ? "Approval needed" : "Your bot has a question",
            subtitle: credential
              ? opened.summary || handoffSubtitle(bot.computer)
              : event.summary,
            options: opened.choices?.length
              ? opened.choices
              : credential
                ? [HANDOFF_CONTINUE]
                : permission
                  ? ["Allow once", "Deny"]
                  : [],
            requestId: event.requestId,
            requestType: opened.requestType,
          },
        });
        if (event.requestId) askMessageByRequest.set(event.requestId, message.id);
        bots.patchBot(bot.id, { state: "NEEDS_INPUT" });
        proactive.noteState(bot.id, "NEEDS_INPUT");
        const peerCtx = delegatedContext(bot);
        if (permission && !credential) {
          setWorkflow(bot.id, { workflowStatus: "blocked", workflowStopReason: AUTONOMY_STOP.approval });
          if (peerCtx?.taskId) {
            broadcastTask(patchAgentTask(peerCtx.taskId, { state: "blocked", blocker: event.summary || "Approval needed" }));
          }
          if (peerCtx) {
            const lead = store.botByThread(peerCtx.sourceThreadId) ?? store.bot(peerCtx.sourceBotId);
            if (lead) {
              upsertLeadReport(
                lead.threadId,
                { kind: "blocker", fromBotId: bot.id, taskId: peerCtx.taskId },
                {
                  role: "bot",
                  kind: "text",
                  text: event.summary || "Approval needed",
                  from: { botId: bot.id, name: bot.name, color: bot.color },
                  task: peerCtx.taskId ? { id: peerCtx.taskId } : undefined,
                },
              );
              setWorkflow(lead.id, {
                workflowStatus: "blocked",
                workflowWaitingFor: removeWaitingFor(lead.workflowWaitingFor, bot.id),
                workflowStopReason: AUTONOMY_STOP.peerBlocked(bot.name, "needs approval"),
              });
            }
          }
        } else {
          setWorkflow(bot.id, { workflowStatus: "needs_input", workflowStopReason: AUTONOMY_STOP.input });
        }
        broadcastBot(bot.id);
        break;
      }
      case "request.resolved": {
        const messageId = event.requestId ? askMessageByRequest.get(event.requestId) : null;
        if (messageId) {
          const existing = store.messagesFor(event.threadId).find((m) => m.id === messageId);
          if (existing?.card && !existing.card.answered) {
            const patched = store.patchMessage(event.threadId, messageId, {
              card: { ...existing.card, answered: event.behavior, dismissed: event.source !== "user" },
            });
            if (patched) broadcast({ kind: "message.patch", threadId: event.threadId, message: patched });
          }
          if (event.requestId) askMessageByRequest.delete(event.requestId);
        }
        if (event.requestId) pendingAskByRequest.delete(event.requestId);
        bots.patchBot(bot.id, { state: "RUNNING" });
        proactive.noteState(bot.id, "RUNNING");
        broadcastBot(bot.id);
        break;
      }
      case "runtime.error": {
        if (event.turnId) responseOptionsByTurn.delete(event.turnId);
        if (event.message) lastRuntimeMessage.set(event.threadId, event.message);
        settleRunningActivities(event.threadId, activityOutcome(false, event.message).status);
        stopScreenPoller(bot.id);
        releaseComputerLease(bot.id);
        const blocked = userFacingBlock({ runtimeMessage: event.message, stopReason: isSpawnFailure(undefined, event.message) ? "spawn_error" : undefined });
        pushMessage({ role: "bot", kind: "activity", tool: { name: `error: ${blocked.stateDetail.slice(0, 160)}`, ok: false } });
        maybeAppendSetupCard(event.threadId, blocked);
        settleDelegatedPeer(bot, { ok: false, detail: blocked.stateDetail });
        bots.patchBot(bot.id, { busy: false, state: "BLOCKED", stateDetail: blocked.stateDetail, stateCode: blocked.stateCode });
        proactive.noteState(bot.id, "BLOCKED");
        notifyIdle(bot.id);
        discardDelegations(commsBus, event.threadId);
        setWorkflow(bot.id, {
          workflowStatus: "blocked",
          workflowStopReason: AUTONOMY_STOP.blocked(blocked.stateDetail),
        });
        broadcastBot(bot.id);
        break;
      }
      case "turn.completed": {
        // the last live frame becomes a settled inline screen message —
        // the screenshot-in-chat moment
        const frame = stopScreenPoller(bot.id);
        releaseComputerLease(bot.id);
        if (frame) pushMessage({ role: "bot", kind: "screen", png: frame.png, mime: frame.mime });
        const tokens = (event.turnId ? turnUsage.get(event.turnId) : undefined) ?? { input: 0, output: 0, cost: null };
        bots.recordTurnUsage(bot.id, { ...tokens, cost: event.cost ?? null });
        usage?.record(event.provider, { requests: 1, inputTokens: tokens.input, outputTokens: tokens.output });
        if (event.turnId) turnUsage.delete(event.turnId);
        const options = event.turnId ? responseOptionsByTurn.get(event.turnId) : undefined;
        if (event.turnId) responseOptionsByTurn.delete(event.turnId);
        if (event.ok && options?.length) {
          pushMessage({
            role: "bot",
            kind: "options",
            card: {
              title: "What would you like to do?",
              subtitle: "Choose a next step, or type your own response.",
              options,
            },
          });
        }
        const priorDetail = bot.stateDetail?.trim();
        const snapshotReason = priorDetail && !isMachineStateCode(priorDetail) ? priorDetail : undefined;
        const runtimeMessage = lastRuntimeMessage.get(event.threadId);
        lastRuntimeMessage.delete(event.threadId);
        const blocked = event.ok
          ? null
          : userFacingBlock({
              stopReason: event.stopReason,
              snapshotReason,
              runtimeMessage,
            });
        if (blocked) maybeAppendSetupCard(event.threadId, blocked);
        const settledAsPeer = (() => {
          const asPeer = delegatedContext(bot);
          if (!asPeer || asPeer.sourceThreadId === bot.threadId) return false;
          const lastText = [...store.messagesFor(event.threadId)]
            .reverse()
            .find((row) => row.kind === "text" && row.role === "bot" && !row.report)?.text;
          settleDelegatedPeer(bot, {
            ok: event.ok,
            text: lastText,
            detail: event.ok ? undefined : (blocked?.stateDetail ?? event.stopReason ?? undefined),
          });
          return true;
        })();
        bots.patchBot(bot.id, {
          busy: false,
          unread: true,
          state: event.ok ? "DONE" : "BLOCKED",
          stateDetail: event.ok ? undefined : (blocked?.stateDetail ?? event.stopReason ?? undefined),
          ...(event.ok ? { stateCode: undefined } : blocked ? { stateCode: blocked.stateCode } : {}),
        });
        proactive.noteState(bot.id, event.ok ? "DONE" : "BLOCKED");
        notifyIdle(bot.id);
        if (event.ok) {
          drainDelegations(commsBus, event.threadId, (toBotId, message, commsDepth, sourceThreadId, channel, taskId) => {
            const target = store.bot(toBotId);
            const source = store.botByThread(sourceThreadId);
            let unsub: (() => void) | undefined;
            if (target && source) {
              if (taskId) {
                delegatedResults.createPending({
                  taskId,
                  workerBotId: target.id,
                  workerThreadId: target.threadId,
                  sourceBotId: source.id,
                  sourceThreadId,
                  parentThreadId: source.threadId,
                  roomThreadId: channel?.threadId ?? null,
                  now: now(),
                });
              }
              delegatedByThread.set(target.threadId, {
                sourceBotId: source.id,
                sourceThreadId,
                taskId,
                channelId: channel?.id,
              });
              setWorkflow(source.id, {
                workflowStatus: "waiting",
                workflowWaitingFor: upsertWaitingFor(source.workflowWaitingFor, {
                  botId: target.id,
                  name: target.name,
                }),
                workflowStopReason: undefined,
              });
              const task = taskId ? agentTasks().get(taskId) : null;
              upsertLeadReport(
                source.threadId,
                { kind: "progress", fromBotId: target.id, taskId },
                {
                  role: "bot",
                  kind: "activity",
                  tool: { name: `@${target.name} started${task?.reason ? `: ${task.reason}` : ""}` },
                  from: { botId: target.id, name: target.name, color: target.color },
                  comm: channel
                    ? { groupId: channel.id, withBotId: target.id, withName: target.name, withColor: target.color }
                    : undefined,
                  task: taskId ? { id: taskId } : undefined,
                },
              );
            }
            if (target && channel) {
              let text = "";
              unsub = bus.subscribe((e: RuntimeEvent) => {
                if (e.threadId !== target.threadId) return;
                if (e.type === "item.completed" && e.itemType === "assistant_text") {
                  const reply = parseResponseOptions(e.text);
                  if (reply.text) text += (text ? "\n" : "") + reply.text;
                } else if (e.type === "turn.completed" || e.type === "runtime.error") {
                  unsub?.();
                  if (e.type === "turn.completed") mirrorReply(commsBus, target, text, channel);
                }
              });
            }
            void service.startTurn(toBotId, message, { commsDepth }).catch(() => {
              unsub?.();
              /* startTurn failures land on the peer thread */
            });
          });
        } else {
          discardDelegations(commsBus, event.threadId);
        }
        {
          if (settledAsPeer) {
            /* finalized before worker-ready / lane release */
          } else if (event.ok) {
            const waiting = waitingFromOpenTasks(bot.threadId);
            if (waiting.length) {
              setWorkflow(bot.id, {
                workflowStatus: "waiting",
                workflowWaitingFor: waiting,
                workflowStopReason: undefined,
              });
            } else {
              setWorkflow(bot.id, {
                workflowStatus: "completed",
                workflowWaitingFor: [],
                workflowStopReason: bot.fullAutonomy === true ? AUTONOMY_STOP.completed : AUTONOMY_STOP.off,
              });
            }
          } else {
            setWorkflow(bot.id, {
              workflowStatus: "blocked",
              workflowStopReason: AUTONOMY_STOP.blocked(blocked?.stateDetail ?? event.stopReason ?? "the turn failed"),
            });
          }
        }
        settleRunningActivities(event.threadId, activityOutcome(event.ok, event.stopReason).status);
        const thenStartTurn = deps.routines().settleTurn(event.threadId, event.ok, event.stopReason);
        if (thenStartTurn) proactive.routineCompleted(thenStartTurn);
        if (event.ok) {
          const turnText = turnTextFromMessages(store.messagesFor(event.threadId));
          const generateText = fleetGenerateText(registry.instances(), bot.modelSelection.instanceId);
          void (async () => {
            await distillMemory({ botId: bot.id, turnText, generateText });
            const extracted = await extractMemory({ botId: bot.id, turnText, generateText });
            // 2026-08-18 [VERIFY]: extract stays suggestions-only. Repeated
            // workflow rows (useCount after inject bump ≥ N) emit the same
            // requestType: "suggestion" card. LLM extract is not a substitute.
            const existingRows = listMemoryRows(bot.id);
            const fromUse = suggestionItemsFromRepeatedWorkflows(bot.id, existingRows);
            if (!extracted.length && !fromUse.length) return;
            const existingCards = store
              .messagesFor(bot.threadId)
              .map((m) => m.card)
              .filter((c): c is NonNullable<typeof c> => !!c);
            const extractCards = suggestionCardsFor(bot.id, extracted, {
              existingRows,
              existingCards,
            });
            const useCards = suggestionCardsFor(bot.id, fromUse, {
              existingCards: [...existingCards, ...extractCards],
            });
            for (const card of [...extractCards, ...useCards]) {
              const message = store.appendMessage(bot.threadId, { role: "bot", kind: "options", card });
              broadcast({ kind: "message", threadId: bot.threadId, message });
            }
          })().catch(() => {
            /* post-turn distill/extract must not fail the turn or log prompts */
          });
        }
        broadcastBot(bot.id);
        break;
      }
    }
  });

  // ── live screen: poll the bot's computer while it works ───────────────
  // Frames stream to clients as SSE {kind:'screen'} (the "Bot's screen"
  // panel); the final frame is folded into the transcript on turn end.
  // Only providers that declare the screenshot capability get a poller.
  //
  // 2026-08-17 [VERIFY] observation loop: there is no computer-observation
  // module in this repo — this per-bot poller IS the observation path,
  // keyed by botId and calling provider.screenshot(botId). In shared mode
  // the lease serializes turns, so at most one bot's poller runs against
  // the shared machine at a time and every panel simply shows the one
  // desktop; re-keying per machine and fanning frames to every bound bot
  // would be a new frame-routing layer, i.e. not cheap — deliberately
  // skipped (spec: "own commit / skip if not cheap").
  type Frame = { png: string; mime: string };
  const screenPollers = new Map<
    string,
    { timer: ReturnType<typeof setInterval>; capture: () => Promise<void>; last: Frame | null }
  >();

  function startScreenPoller(botId: string) {
    if (screenPollers.has(botId)) return;
    const provider = boundProvider(store.bot(botId)?.computer);
    if (!provider?.capabilities.screenshot) return;
    let inFlight = false;
    const capture = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const { png, format } = await provider.screenshot(botId);
        // Clearing an interval cannot cancel a screenshot already in flight.
        // Ignore that late result once this exact poller has been stopped or
        // replaced so a released shared machine never broadcasts under its
        // former holder's bot id.
        if (screenPollers.get(botId) !== entry) return;
        const frame = { png, mime: format === "jpeg" ? "image/jpeg" : "image/png" };
        entry.last = frame;
        teach.noteFrame(botId);
        broadcast({ kind: "screen", botId, ...frame });
      } catch {
        /* box asleep or mid-command — try again next tick */
      } finally {
        inFlight = false;
      }
    };
    const entry = {
      timer: setInterval(capture, 4000),
      capture,
      last: null as Frame | null,
    };
    screenPollers.set(botId, entry);
  }

  /** Event-driven refresh: capture NOW (the bot just acted on its screen)
   * instead of waiting for the next interval tick. */
  function pokeScreenPoller(botId: string) {
    void screenPollers.get(botId)?.capture();
  }

  function stopScreenPoller(botId: string): Frame | null {
    const entry = screenPollers.get(botId);
    if (!entry) return null;
    clearInterval(entry.timer);
    screenPollers.delete(botId);
    return entry.last;
  }

  async function settleUnavailableTurn(
    bot: { id: string; threadId: string },
    userMessageId: string,
    opts: { zeroEngines: boolean; snapshotReason?: string | null; offerSwitch?: boolean },
  ): Promise<{ threadId: string; messageId: string }> {
    const blocked = userFacingBlock({
      zeroEngines: opts.zeroEngines,
      snapshotReason: opts.snapshotReason,
      // Pre-spawn: we never launched a child, so this is not spawn_error.
      stopReason: opts.zeroEngines ? "no_engines" : "engine_unavailable",
    });
    const card = engineSetupCard({
      reason: blocked.stateDetail,
      zeroEngines: opts.zeroEngines,
      offerSwitch: opts.offerSwitch === true && !opts.zeroEngines,
    });
    const setup = store.appendMessage(bot.threadId, { role: "bot", kind: "options", card });
    broadcast({ kind: "message", threadId: bot.threadId, message: setup });
    bots.patchBot(bot.id, {
      busy: false,
      unread: true,
      state: "BLOCKED",
      stateDetail: blocked.stateDetail,
      stateCode: blocked.stateCode,
    });
    proactive.noteState(bot.id, "BLOCKED");
    notifyIdle(bot.id);
    broadcastBot(bot.id);
    return { threadId: bot.threadId, messageId: userMessageId };
  }

  // ── turn dispatch (upstream ProviderCommandReactor, miniature) ──────────
  async function startTurn(botId: string, text: string, opts?: StartTurnOpts): Promise<{ threadId: string; messageId: string }> {
    const bot = store.bot(botId);
    if (!bot) throw Object.assign(new Error("no such bot"), { status: 404 });
    if (bot.busy) throw Object.assign(new Error("the bot is already working — interrupt it first"), { status: 409 });
    proactive.reset(botId);
    const commsDepth = opts?.commsDepth ?? 0;
    const autonomyContinue = opts?.autonomyContinue === true;
    const visited = uniqueIds([...(opts?.visited ?? []), bot.id]);
    const groupThreadId = opts?.groupThreadId ?? (commsDepth === 0 ? bot.threadId : undefined);
    // listener / inherited hop: mark this bot. A person typing into this
    // bot (no commsDepth, no unattended flag) ends the window immediately
    // so P0.1 interactive Always-allow still auto-resolves.
    if (opts?.unattended) markUnattended(bot.id, now());
    else if (commsDepth === 0) clearUnattended(bot.id);

    const providedRequestId = typeof opts?.requestId === "string" && opts.requestId.trim() ? opts.requestId.trim() : "";
    const requestId = lineage
      ? lineage.begin({
          ...(providedRequestId ? { requestId: providedRequestId } : {}),
          source: lineageSourceFor(opts),
          botId,
          threadId: bot.threadId,
        }).requestId
      : providedRequestId || newId();
    lineage?.bindThread(bot.threadId, requestId);

    const instance = registry.get(bot.modelSelection.instanceId);
    if (!instance) {
      throw Object.assign(
        new Error(`provider instance "${bot.modelSelection.instanceId}" is unavailable — pick another model in settings`),
        { status: 409 },
      );
    }
    if (bot.computer === "local" && instance.adapter.capabilities.localComputerMcp !== true) {
      throw Object.assign(new Error("selected provider does not support guarded local computer control"), { status: 409 });
    }
    const configured = cfg.instances?.[bot.modelSelection.instanceId];
    const fullAuto = configured?.config && typeof configured.config === "object" && (configured.config as { fullAuto?: unknown }).fullAuto === true;
    // per-bot Always allow is the same hazard class as provider full-auto:
    // no cards while driving THIS machine is never a valid combination
    if (bot.computer === "local" && (fullAuto || bot.alwaysAllow === true)) {
      const what = fullAuto ? "provider full-auto" : "Always allow";
      bots.patchBot(bot.id, { state: "BLOCKED", stateDetail: `local computer cannot be combined with ${what}` });
      proactive.noteState(bot.id, "BLOCKED");
      throw Object.assign(new Error(`unsafe configuration: local computer cannot be combined with ${what}`), { status: 409 });
    }

    const userMessage = autonomyContinue
      ? store.appendMessage(bot.threadId, {
          role: "bot",
          kind: "activity",
          tool: completedNote("Continuing autonomously"),
        })
      : store.appendMessage(bot.threadId, { role: "user", kind: "text", text });
    broadcast({ kind: "message", threadId: bot.threadId, message: userMessage });

    // transcript for API-backed drivers: settled text turns only
    const transcript = store
      .messagesFor(bot.threadId)
      .filter((m) => m.kind === "text" && m.text && m.id !== userMessage.id)
      .slice(-40)
      .map((m) => ({ role: m.role === "user" ? ("user" as const) : ("assistant" as const), text: m.text! }));
    if (autonomyContinue) transcript.push({ role: "user", text });

    const attachedSkills = skillsForTurn(bot, opts?.extraSkillIds ?? []);
    const persona = [
      `You are ${bot.name}, a personal bot in VelarixBot.`,
      bot.title && `Role: ${bot.title}.`,
      bot.description && `About: ${bot.description}`,
      "Stay in that character. Coordinate in this VelarixBot workspace; do not implement the user's repo or run a coding audit unless they explicitly ask for code. Do not dump a feature tour or A/B/C onboarding.",
    ]
      .filter(Boolean)
      .join(" ") + skillSystemNote(attachedSkills);

    // busy flips immediately so the composer locks; the dispatch itself runs
    // in the background — box provisioning can take ~90s and must never
    // hang the HTTP request
    bots.patchBot(bot.id, {
      busy: true,
      unread: false,
      state: "RUNNING",
      stateDetail: undefined,
      workflowStatus: "working",
      workflowStopReason: undefined,
      ...(autonomyContinue
        ? {}
        : commsDepth === 0
          ? { workflowWaitingFor: [], workflowAutonomyHops: 0 }
          : {}),
    });
    proactive.noteState(bot.id, "RUNNING");
    broadcastBot(bot.id);

    void (async () => {
      try {
        // [VERIFY] 2026-08-18: skip spawn synchronously when the selected
        // (or every) instance's CLI is missing — absolute path not on disk
        // OR a bare PATH name (claude/codex/grok/gemini) that findOnPath
        // cannot resolve. API/fake instances have no cli and stay
        // spawnable so #98 drain/ask_bot still calls sendTurn on the same
        // tick. Must not await describe() here.
        {
          const live = registry.instances();
          const spawnable = live.filter((inst) => !cliMissing(inst.cli));
          const selectedMissing = cliMissing(instance.cli);
          if (spawnable.length === 0 || selectedMissing) {
            await settleUnavailableTurn(bot, userMessage.id, {
              zeroEngines: spawnable.length === 0,
              snapshotReason: selectedMissing
                ? `\`${instance.cli}\` CLI not found`
                : `provider instance "${bot.modelSelection.instanceId}" is unavailable`,
              offerSwitch: spawnable.length > 0,
            });
            return;
          }
        }
        const integrations: NonNullable<Parameters<typeof instance.adapter.sendTurn>[0]["integrations"]> = {};
        // Same-tick sendTurn for fake/API instances (delegations drain).
        // Only await Bitwarden when a token is configured AND this bot has
        // an explicit allowlist — default-none stays synchronous.
        const bitwarden =
          bitwardenConfigured(cfg) && ((bot.bitwardenSecretIds?.length ?? 0) > 0 || (bot.bitwardenProjectIds?.length ?? 0) > 0)
            ? await fetchApprovedSecretEnv(cfg, bot)
            : { env: {}, keys: [] };
        if (bot.enabledApps?.length && composioSessionKey(cfg)) {
          const session = await ensureBotSession(cfg, bot.id, bot.enabledApps);
          if (session) {
            integrations.composio = composioIntegration(sessionProxyEnv(session, bot.enabledApps));
          }
        }
        // The bot's computer BINDING resolves to a provider; only drivers
        // that can actually act on that machine (mount the provider-built
        // computer MCP tools, or run on the machine itself) get
        // integrations.computer — otherwise the "you have a computer"
        // prompt below would be a lie the model repeats to the user.
        const computerProvider = boundProvider(bot.computer);
        if (computerProvider && bot.computer !== "local" && instance.adapter.capabilities.cloudComputer === true) {
          const status = await computerProvider.status(bot.id).catch(() => null);
          if (status?.configured) {
            let machine = status.machine;
            // drivers that run ON the machine (boxAgent) provision on first use
            if (!machine && instance.driverKind === "boxAgent") {
              broadcast({ kind: "computer", botId: bot.id, state: "provisioning" });
              await computerProvider.provision({ id: bot.id, name: bot.name });
              machine = (await computerProvider.status(bot.id).catch(() => null))?.machine ?? null;
            }
            if (machine) {
              integrations.computer = {
                provider: computerProvider.kind,
                mcp: computerProvider.capabilities.mcp
                  ? await computerProvider.mcpIntegration(bot.id, { machineId: machine.id })
                  : null,
                handle: { machineId: machine.id },
              };
              repos.computerBindings.record(bot.id, machine.id);
              // 2026-08-17 [VERIFY] dispatch site: this block is the ONE
              // place a turn gets its machine — the computer MCP mount for
              // CLI drivers AND the handle boxAgent runs on — so the lease
              // acquired here covers normal, routine, listener/unattended,
              // and boxAgent turns alike (every path enters via startTurn;
              // adapter.sendTurn has no other production caller). A second
              // acquire inside boxAgent.sendTurn would deadlock this FIFO,
              // so boxAgent's serialization IS this acquire. Box-native
              // /prompt concurrency could not be probed live (no token in
              // this environment) — until proven safe, serialize here.
              // Timeout fails LOUD below; the lease is released when the
              // turn settles (turn.completed / runtime.error / dispatch
              // catch / interrupt) — never a silent proceed-without-tools.
              // key registered BEFORE the await so an interrupt during the
              // queue wait aborts the wait instead of leaking a zombie turn
              leaseKeyByBot.set(bot.id, `${computerProvider.kind}:${machine.id}`);
              await leases.acquire(`${computerProvider.kind}:${machine.id}`, { id: bot.id, name: bot.name }, { waitMs: leaseWaitMs() });
            }
          }
        }
        // local computer (this machine) via the Electron-hosted cua-driver:
        // the Electron main process owns the daemon (TCC attribution); the
        // local provider only reads its spawn contract from cua-connection.json
        if (computerProvider && bot.computer === "local") {
          const mcp = await computerProvider.mcpIntegration(bot.id);
          if (mcp) integrations.computer = { provider: computerProvider.kind, mcp };
        }
        // peer-agent comms: give a user-initiated turn list_bots / ask_bot /
        // create_bot / delete_bot. Always mount at depth 0 so a lone bot can still create
        // sidebar peers. A comms-invoked turn (depth ≥ cap) gets none — hard
        // recursion stop. Only drivers that mount the tools get the integration
        // (and the prompt hint). Any bot can still be the TARGET of ask_bot.
        if (commsDepth < MAX_COMMS_DEPTH && instance.adapter.capabilities.agentsMcp === true) {
          integrations.agents = agentsIntegration(bot.id, commsDepth, visited, groupThreadId);
        }
        if (instance.adapter.capabilities.agentsMcp === true) {
          integrations.memory = memoryIntegration(bot.id);
          integrations.workspace = workspaceIntegration(bot.id, commsDepth);
        }
        // @mentions in the user's message (the composer's tagging UI) become
        // an explicit delegation nudge — the agent still does the ask_bot call
        // itself, so the harness stays the single owner of turns/permissions
        const tagged = integrations.agents
          ? mentionedBots(
              text,
              bots.bots().filter((b) => b.id !== bot.id),
            )
          : [];
        if (tagged.length) {
          bots.patchBot(bot.id, {
            threadParticipants: uniqueIds([bot.id, ...(bot.threadParticipants ?? []), ...tagged.map((t) => t.id)]),
          });
        }

        const started = await instance.adapter.sendTurn({
          threadId: bot.threadId,
          text,
          model: bot.modelSelection.model,
          ...(bot.modelSelection.effort ? { effort: bot.modelSelection.effort } : {}),
          resumeCursor: bot.resumeCursors[bot.modelSelection.instanceId],
          transcript,
          attachments: opts?.attachments,
          cwd: ensureBotWorkspace(bot.id),
          ...(Object.keys(bitwarden.env).length ? { environment: bitwarden.env } : {}),
          system:
            persona +
            // 2026-08-18 [VERIFY]: #102 memoryPrompt used bumpUse: false.
            // Inject now increments useCount on this bot's injected row docs.
            memoryPrompt(bot.id) +
            turnGrounding(instance.driverKind) +
            (shouldAttachResponseOptions(instance.driverKind) ? responseOptionsPrompt : "") +
            // the provider owns its prompt line; boxAgent runs ON the
            // machine and carries its own on-box grounding instead
            (integrations.computer && instance.driverKind !== "boxAgent" && computerProvider?.turnPrompt
              ? ` ${computerProvider.turnPrompt}`
              : "") +
            (integrations.agents ? agentsCommsPrompt({ fullAutonomy: bot.fullAutonomy === true }) : "") +
            (integrations.memory
              ? " You have remember and recall tools. remember saves a lasting note for this bot (or the shared workspace). recall reads those notes. Prefer remember for durable facts instead of relying on chat history."
              : "") +
            (integrations.workspace
              ? " Workspace tools: web_search and fetch_page look things up (you have no in-app browser). ask_choice asks the user a multiple-choice question. ask_secret asks for a password/code — the value never appears in chat; never ask them to paste a token in the transcript. create_routine schedules work (weekdays by default). A github listener needs one owner/name repo and an event list (token lives in App Settings). A slack listener needs a channel or DM plus mention|keyword|message, and connect_app first. A discord listener needs match: mention|dm|channel|keyword|reaction|thread and fires on inbound Discord events (unattended). save_skill / run_skill store and follow step recipes. attach_to_chat puts a computer screenshot or file into this thread. connect_app starts installing a catalog app (github, slack, …) via a user connect card. list_approved_secrets / get_approved_secret read Bitwarden secrets the user explicitly allowed for this bot — never print those values."
              : "") +
            (bitwarden.keys.length
              ? ` Approved Bitwarden secrets for this bot are in the process environment as ${bitwarden.keys.join(", ")}. Never print those values.`
              : "") +
            (tagged.length
              ? ` The user tagged ${tagged
                  .map((t) => `@${t.name} (ask_bot bot_id ${t.id})`)
                  .join(" and ")} in their message — bring them into this group thread with ask_bot. Their replies belong in this transcript; do not route handoffs through the user.`
              : "") +
            (opts?.systemNote ? ` ${opts.systemNote}` : ""),
          integrations,
          requireApproval: bot.requireApproval === true || isUnattended(bot.id),
        });
        bindDelegatedRun(bot, started.turnId, now());
        if (integrations.computer) startScreenPoller(bot.id);
      } catch (e) {
        // covers the lease-wait timeout ("computer busy — in use by <bot>")
        // and an aborted queue wait as well as sendTurn failures: the error
        // lands in the transcript and the bot goes BLOCKED — never a silent
        // proceed without the computer
        stopScreenPoller(bot.id);
        releaseComputerLease(bot.id);
        const message = e instanceof Error ? e.message : String(e);
        settleRunningActivities(bot.threadId, activityOutcome(false, message).status);
        const blocked = userFacingBlock({ runtimeMessage: message, stopReason: isSpawnFailure(undefined, message) ? "spawn_error" : undefined });
        const failure = store.appendMessage(bot.threadId, {
          role: "bot",
          kind: "activity",
          tool: { name: `error: ${blocked.stateDetail.slice(0, 160)}`, ok: false },
        });
        broadcast({ kind: "message", threadId: bot.threadId, message: failure });
        maybeAppendSetupCard(bot.threadId, blocked);
        settleDelegatedPeer(bot, { ok: false, detail: blocked.stateDetail });
        bots.patchBot(bot.id, { busy: false, state: "BLOCKED", stateDetail: blocked.stateDetail, stateCode: blocked.stateCode });
        proactive.noteState(bot.id, "BLOCKED");
        notifyIdle(bot.id);
        discardDelegations(commsBus, bot.threadId);
        setWorkflow(bot.id, {
          workflowStatus: "blocked",
          workflowStopReason: AUTONOMY_STOP.blocked(blocked.stateDetail),
        });
        broadcastBot(bot.id);
      }
    })();
    return { threadId: bot.threadId, messageId: userMessage.id };
  }

  // ── user response to a pending ask / permission card ──────────────────
  async function respond(
    botId: string,
    requestId: string,
    body: { behavior?: unknown; message?: unknown; always?: unknown; persistScope?: unknown },
  ): Promise<{ ok: true } | { error: string; status: number }> {
    const bot = store.bot(botId);
    if (!bot) return { error: "no such bot", status: 404 };
    const waiter = userAskWaiters.get(requestId);
    if (waiter) {
      const secret = waiter.secret;
      const raw = String(body.message ?? "").trim() || String(body.behavior ?? "");
      const display = secret ? SECRET_CARD_ANSWER : raw || "ok";
      const messageId = askMessageByRequest.get(requestId);
      if (messageId) {
        const existing = store.messagesFor(bot.threadId).find((msg) => msg.id === messageId);
        if (existing?.card) {
          const patched = store.patchMessage(bot.threadId, messageId, {
            card: { ...existing.card, answered: display },
          });
          if (patched) broadcast({ kind: "message.patch", threadId: bot.threadId, message: patched });
        }
      } else {
        const existing = store.messagesFor(bot.threadId).find((msg) => msg.card?.requestId === requestId);
        if (existing?.card) {
          const patched = store.patchMessage(bot.threadId, existing.id, {
            card: { ...existing.card, answered: display },
          });
          if (patched) broadcast({ kind: "message.patch", threadId: bot.threadId, message: patched });
        }
      }
      pendingAskByRequest.delete(requestId);
      settleUserAsk(requestId, secret ? raw : display);
      return { ok: true };
    }
    const instance = registry.get(bot.modelSelection.instanceId);
    if (!instance) return { error: "provider unavailable", status: 409 };
    const pending = pendingAskByRequest.get(requestId);
    if (pending?.requestType === "permission") {
      // A rule persists ONLY on an explicit Always-allow (`always: true`).
      // Plain Allow-once persists nothing; Deny and credential asks never
      // persist; scope defaults to this bot — "workspace" is the explicit
      // Advanced: all-bots consent.
      const persisted = persistAllowRule({
        botId: bot.id,
        tool: pending.tool,
        summary: pending.summary,
        behavior: String(body.behavior ?? ""),
        always: body.always === true,
        scope: body.persistScope === "workspace" ? "workspace" : "bot",
        requestType: pending.requestType,
      });
      appendAudit({
        bot: bot.id,
        tool: pending.tool,
        matcher: argumentPattern(pending.summary),
        decision: `user.${String(body.behavior ?? "")}${body.always === true ? ".always" : ""}`,
        ...(persisted ? { ruleId: persisted.id } : {}),
      });
    }
    await instance.adapter.respondToRequest(bot.threadId, requestId, {
      behavior: body.behavior as "allow" | "deny" | "answer",
      message: typeof body.message === "string" ? body.message : undefined,
      always: body.always === true,
      source: "user",
    });
    return { ok: true };
  }

  async function interrupt(botId: string): Promise<{ ok: true } | { error: string; status: number }> {
    const bot = store.bot(botId);
    if (!bot) return { error: "no such bot", status: 404 };
    const instance = registry.get(bot.modelSelection.instanceId);
    // Abort releases the machine lease (or queued wait) and its screenshot
    // interval immediately. A later turn.completed cleanup is idempotent.
        stopScreenPoller(botId);
        releaseComputerLease(botId);
        settleRunningActivities(bot.threadId, "cancelled");
        await instance?.adapter.interruptTurn(bot.threadId);
    settleDelegatedPeer(bot, { ok: false, detail: "interrupted" });
        bots.patchBot(bot.id, { busy: false, state: "BLOCKED", stateDetail: "interrupted" });
    proactive.noteState(bot.id, "BLOCKED");
    notifyIdle(bot.id);
    discardDelegations(commsBus, bot.threadId);
    setWorkflow(bot.id, {
      workflowStatus: "paused",
      workflowStopReason: AUTONOMY_STOP.paused,
    });
    broadcastBot(bot.id);
    return { ok: true };
  }

  const service: TurnsService = {
    startTurn,
    askBotQueued(toBotId, message, depth, opts) {
      // snapshot BEFORE the queue waits: a TTL expiry while the peer is
      // busy must not drop the gate on a 3am listener hop.
      const unattended = hopUnattended(opts);
      const hop = () => peerQueue.enqueue(toBotId, () => askBotAndWait(toBotId, message, depth, { ...opts, unattended }));
      const scheduler = deps.lanes?.();
      if (!scheduler) return hop();
      return scheduler
        .enqueue({
          lane: "agent",
          botId: toBotId,
          text: message,
          opts: { ...opts, unattended },
          run: hop,
        })
        .then(async (accepted) => {
          if (accepted.status === "duplicate") return "(duplicate agent turn)";
          try {
            return String(await accepted.settled);
          } catch (error) {
            return `(couldn't start that bot: ${error instanceof Error ? error.message : String(error)})`;
          }
        });
    },
    handleWorkspaceTool,
    askUserAndWait,
    createSidebarBot,
    removeSidebarBot,
    respond,
    interrupt,
    defaultSelection,
    selectionForModel,
    lastScreenFrame(botId) {
      return screenPollers.get(botId)?.last ?? null;
    },
    noteScreenshot(botId) {
      if (screenPollers.has(botId)) return;
      teach.noteFrame(botId);
    },
  };
  return service;
}
