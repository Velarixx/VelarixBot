// Composition root (P0.5). createApplication wires repositories, providers,
// the event bus, and a clock into services, then mounts the route modules.
// index.ts only reads the environment, opens the database, and listens —
// tests can build the whole application against fakes.
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join } from "node:path";

import {
  authenticateApiRequest,
  normalizeSaasApplicationOrigin,
  type ApplicationAuthentication,
} from "./auth.ts";
import { boxMaintenance } from "./computer/box.ts";
import { createLeaseBroker } from "./computer/leases.ts";
import { createComputerRegistry, type ComputerRegistry } from "./computer/registry.ts";
import { defaultAvatarImageGenerator, type GenerateAvatarImages } from "./avatar-image.ts";
import type { AppConfig } from "./config.ts";
import type { RuntimeEvent } from "./contracts.ts";
import type { EventBus } from "./harness/bus.ts";
import type { ProviderRegistry } from "./harness/registry.ts";
import { IdentitySessions } from "./identity.ts";
import type { GithubOAuthProvider } from "./oauth/github-provider.ts";
import { OAuthTransactionStore } from "./oauth/transactions.ts";
import { createProactive, type Proactive } from "./proactive.ts";
import { UI_STREAM_ID } from "./repositories/event-log.ts";
import type { Repositories } from "./repositories/index.ts";
import { createChannelRegistry } from "./channels/registry.ts";
import { createApprovalsRoutes } from "./routes/approvals.ts";
import { createBotsRoutes } from "./routes/bots.ts";
import { createChannelsRoutes } from "./routes/channels.ts";
import { createComputersRoutes } from "./routes/computers.ts";
import { json, type RouteCtx, type RouteHandler } from "./routes/context.ts";
import { createDiagnosticsRoutes } from "./routes/diagnostics.ts";
import { createEventsRoutes } from "./routes/events.ts";
import { createHealthRoutes } from "./routes/health.ts";
import { createIntegrationsRoutes } from "./routes/integrations.ts";
import { createOAuthRoutes } from "./routes/oauth.ts";
import { createRoutinesRoutes } from "./routes/routines.ts";
import { createSaasBotCatalogRoutes } from "./routes/saas-bot-catalog.ts";
import { createSaasDesktopAccessRoutes } from "./routes/saas-desktop-access.ts";
import { createSessionRoutes } from "./routes/session.ts";
import { createTurnsRoutes } from "./routes/turns.ts";
import { createBotsService, projectPublicBotFrame, type BotsService } from "./services/bots.ts";
import { createChannelsService, type ChannelsService } from "./services/channels.ts";
import { createGroupsService, type GroupsService } from "./services/groups.ts";
import { createDiagnosticsService } from "./services/diagnostics.ts";
import { createDesktopAccessGrantService } from "./services/desktop-access-grants.ts";
import { createDesktopViewerBroker } from "./services/desktop-viewer-broker.ts";
import { createSseHub, type Broadcast, type SseHub } from "./services/events.ts";
import { createListenerPoller } from "./listeners/index.ts";
import { createTelegramApi, type TelegramApi } from "./telegram-api.ts";
import { createTelegramService, type TelegramService } from "./telegram.ts";
import { createDiscordService, type DiscordService } from "./discord.ts";
import { createDiscordChannelConnector, type DiscordConnectInput } from "./channels/discord.ts";
import { createRoutinesService, type RoutinesService } from "./services/routines.ts";
import { createSecurityAuditService } from "./services/security-audit.ts";
import { createTeachService, type TeachService } from "./services/teach.ts";
import { createTurnsService, type TurnsService } from "./services/turns.ts";
import type { ModelSelection } from "./contracts.ts";
import { configureAgentTasks } from "./agent-tasks.ts";
import { configureMemoryStore } from "./memory.ts";
import { getSkill, skillPrompt } from "./teach.ts";

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

export interface Clock {
  now(): number;
}

export interface CreateApplicationInput {
  repos: Repositories;
  providers: ProviderRegistry;
  /** Computer provider registry — built from cfg when not injected. */
  computers?: ComputerRegistry;
  bus: EventBus;
  cfg: AppConfig;
  clock?: Clock;
  port: number;
  apiToken: string;
  /** Desktop is the default. SaaS mounts only identity/OAuth, health,
   * owner-bound catalog, and scoped desktop-view capabilities. */
  auth?:
    | { mode: "desktop" }
    | { mode: "saas"; applicationOrigin: string; oauthProvider: GithubOAuthProvider };
  commsToken: string;
  staticDir: string | null;
  stamp: string;
  reloadProviders(): Promise<void>;
  /** A2: injectable so tests never hit a live image API. */
  generateAvatarImages?: GenerateAvatarImages;
  /** Injected Telegram Bot API (tests). Default long-polls api.telegram.org. */
  telegramApi?: TelegramApi;
  /** Injected Discord Gateway/REST (tests). Default uses node WebSocket + fetch. */
  discordConnect?: () => Partial<DiscordConnectInput>;
}

export interface Application {
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
  /** Drive the schedulers (routines + stall nudges). Fake-clock friendly. */
  tick(now?: number): void;
  hub: SseHub;
  services: {
    bots: BotsService;
    groups: GroupsService;
    turns: TurnsService;
    routines: RoutinesService;
    teach: TeachService;
    proactive: Proactive;
    telegram: TelegramService;
    discord: DiscordService;
    channels: ChannelsService;
  };
}

export async function createApplication(input: CreateApplicationInput): Promise<Application> {
  const { repos, providers: registry, bus, cfg, port, apiToken, commsToken, staticDir, stamp } = input;
  const clock: Clock = input.clock ?? { now: () => Date.now() };
  const auth = input.auth ?? { mode: "desktop" as const };
  const rawIdentitySessions = auth.mode === "saas" ? new IdentitySessions(repos.db) : null;
  const securityAudit =
    auth.mode === "saas"
      ? createSecurityAuditService({
          db: repos.db,
          eventLog: repos.eventLog,
          sessions: rawIdentitySessions!,
          desktopAccessGrants: repos.desktopAccessGrants,
          now: () => clock.now(),
        })
      : null;
  const identitySessions = securityAudit?.sessions ?? null;
  const desktopAccessGrants =
    auth.mode === "saas"
      ? createDesktopAccessGrantService({
          repos: { ...repos, desktopAccessGrants: securityAudit!.desktopAccessGrants },
          policy: {
            maxActiveGrantsPerOwner: 2,
            defaultTtlMs: 60_000,
            maxTtlMs: 120_000,
          },
          // Successful issue plus resolve/revoke decisions reach the audited
          // repository capability above. Pre-mint issue denials do not, so
          // persist only those here and leave success ownership in one place.
          audit(event) {
            if (
              event.action === "issue" &&
              event.outcome !== "succeeded" &&
              (event.reason === "no_current_binding" || event.reason === "quota")
            ) {
              securityAudit!.recordTenant(event.ownerId, {
                action: "grant.issue",
                decision: "deny",
                reason: event.reason,
              });
            }
          },
          now: () => clock.now(),
        })
      : null;
  const authentication: ApplicationAuthentication =
    auth.mode === "desktop"
      ? { mode: "desktop", token: apiToken, port }
      : {
          mode: "saas",
          applicationOrigin: normalizeSaasApplicationOrigin(auth.applicationOrigin),
          sessions: identitySessions!,
          now: () => clock.now(),
        };
  configureMemoryStore(repos.memoryRows);
  configureAgentTasks(repos.agentTasks);

  // the hub's semantic frames are durable on the event log's "ui" stream
  // (P1.3): SSE id:/Last-Event-ID resume replays exactly the missed frames
  const hub = createSseHub({
    streamId: UI_STREAM_ID,
    append: (type, payload) => repos.eventLog.appendToStream(UI_STREAM_ID, type, payload),
    replayAfter: (after) => repos.eventLog.replayAfter(UI_STREAM_ID, after),
    latest: () => repos.eventLog.latestSequence(UI_STREAM_ID),
    oldest: () => repos.eventLog.oldestSequence(UI_STREAM_ID),
  });
  // Late-bound: bots is created below. Every {kind:"bot"} frame is
  // projected through the publicBot allowlist before it hits the wire
  // (live SSE + durable ui-stream replay).
  let botsRef: BotsService | null = null;
  let telegramRef: TelegramService | null = null;
  let discordRef: DiscordService | null = null;
  const broadcast: Broadcast = (payload) => {
    hub.broadcast(projectPublicBotFrame(payload, (id) => botsRef?.publicBot(id) ?? null));
    telegramRef?.onBroadcast(payload);
    discordRef?.onBroadcast(payload);
  };

  // canonical events are mirrored into SQLite (event_log); the per-thread
  // NDJSON files stay on as the export surface (harness/bus.ts)
  bus.subscribe((event: RuntimeEvent) => {
    try {
      repos.eventLog.append(event);
    } catch {
      /* the stream must never die on a log write */
    }
  });

  // boot recovery: a bot that died mid-turn reloads as BLOCKED/interrupted,
  // and any routine run the dead process left open closes as interrupted
  // (single process — a running row at boot cannot have a live owner)
  repos.bots.recoverInterrupted();
  repos.routines.recoverInterrupted(clock.now());

  // computer providers: local is core; box is the bundled default and an
  // authored config map can remove it — nothing here needs a Box token
  const computers = input.computers ?? (await createComputerRegistry({ cfg }));
  const desktopViewerBroker =
    auth.mode === "saas"
      ? createDesktopViewerBroker({
          repos,
          grants: desktopAccessGrants!,
          computers,
          openTimeoutMs: 2_000,
          authorizationIntervalMs: 250,
          now: () => clock.now(),
        })
      : null;

  // default selection resolves asynchronously; bots created before that use
  // the boot placeholder (exactly the pre-refactor behavior)
  let bootSelection: ModelSelection = { instanceId: "claude", model: "claude-sonnet-5" };
  const bots = createBotsService({
    repos,
    defaultSelection: () => bootSelection,
    computerBindings: () => computers.list().map((p) => p.id),
  });
  botsRef = bots;
  const groups = createGroupsService({ repos });

  const teach = createTeachService({
    bus,
    registry,
    bot: (id) => bots.bot(id),
    patchBot: (id, patch) => bots.patchBot(id, patch),
  });

  let turnsRef: TurnsService | null = null;
  const proactive = createProactive({
    now: () => clock.now(),
    onNudge: (botId) => {
      const bot = bots.bot(botId);
      if (!bot) return;
      bots.patchBot(botId, { unread: true });
      broadcast({ kind: "bot", bot: bots.publicBot(botId) });
      broadcast({ kind: "nudge", botId, reason: "stall" });
    },
    onTrigger: (botId, prompt) => {
      void turnsRef?.startTurn(botId, prompt).catch(() => {});
    },
  });

  // ONE machine-lease broker for the whole install: turn dispatch acquires
  // on it, the computer routes' suspend guard and "in use by" read it
  const computerLeases = createLeaseBroker();

  let routinesRef: RoutinesService | null = null;
  const turns = createTurnsService({
    cfg,
    registry,
    computers,
    bus,
    repos,
    bots,
    groups,
    routines: () => routinesRef!,
    teach,
    proactive,
    broadcast,
    port,
    commsToken,
    now: () => clock.now(),
    leases: computerLeases,
  });
  turnsRef = turns;

  const routines = createRoutinesService({
    repos,
    now: () => clock.now(),
    broadcast,
    bot: (id) => {
      const b = bots.bot(id);
      return b ? { id: b.id, threadId: b.threadId, busy: b.busy, hidden: b.hidden === true } : null;
    },
    startTurn: (botId, text, opts) => turns.startTurn(botId, text, opts),
    getSkill,
    skillPrompt,
    pollListener: createListenerPoller({ cfg: () => cfg }),
  });
  routinesRef = routines;

  bootSelection = await turns.defaultSelection();
  bots.seedIfEmpty();
  teach.restoreTeachSubscriptions();

  // P1.7: the redacted support bundle + verified profile backup — reads the
  // same repositories/registries as everything else, never message content
  const diagnostics = createDiagnosticsService({ repos, providers: registry, computers, stamp });

  const discordConnector = createDiscordChannelConnector({ id: "discord" });
  const channelRegistry = await createChannelRegistry();
  const channels = createChannelsService({
    registry: channelRegistry,
    bus,
    now: () => clock.now(),
  });
  channels.register(discordConnector);

  let integrationsRef: ReturnType<typeof createIntegrationsRoutes> | null = null;
  const telegram = createTelegramService({
    cfg: () => cfg,
    api: input.telegramApi ?? createTelegramApi(),
    conversations: repos.telegramConversations,
    bots,
    startTurn: (botId, text) => turns.startTurn(botId, text),
    now: () => clock.now(),
    onStatusChange: () => {
      const snapshot = integrationsRef?.configStatus();
      if (snapshot) broadcast({ kind: "config", ...snapshot });
    },
  });
  telegramRef = telegram;

  const discord = createDiscordService({
    cfg: () => cfg,
    connector: discordConnector,
    conversations: repos.discordConversations,
    bots,
    groups,
    startTurn: (botId, text, opts) => turns.startTurn(botId, text, { ...opts, unattended: true }),
    now: () => clock.now(),
    connectOpts: input.discordConnect,
    onStatusChange: () => {
      const snapshot = integrationsRef?.configStatus();
      if (snapshot) broadcast({ kind: "config", ...snapshot });
    },
  });
  discordRef = discord;

  const integrations = createIntegrationsRoutes({
    bots,
    groups,
    turns,
    registry,
    cfg,
    commsToken,
    broadcast,
    reloadProviders: input.reloadProviders,
    telegram,
    discord,
  });
  integrationsRef = integrations;
  telegram.applyConfig();
  discord.applyConfig();

  // route order preserves the pre-refactor dispatch: internal comms first
  // (their own token), then the launch-token gate, then the public surface
  const desktopRoutes: RouteHandler[] = [
    createEventsRoutes({ hub, bots, groups, tasks: repos.agentTasks }),
    createRoutinesRoutes({ routines }),
    createApprovalsRoutes({ bots }),
    createBotsRoutes({
      bots,
      turns,
      teach,
      routines,
      registry,
      computers,
      cfg,
      broadcast,
      generateAvatarImages: input.generateAvatarImages ?? defaultAvatarImageGenerator(),
    }),
    createTurnsRoutes({ turns }),
    createHealthRoutes({ staticServing: Boolean(staticDir), stamp }),
    createDiagnosticsRoutes({ diagnostics }),
    createChannelsRoutes({ channels }),
    integrations.api,
    createComputersRoutes({
      bots,
      computers,
      recordBinding: (botId, machineId) => repos.computerBindings.record(botId, machineId),
      onScreenshot: (botId) => turns.noteScreenshot(botId),
      leases: computerLeases,
      // the composition root knows the vendor knob; routes stay vendor-blind
      isShared: (provider) => provider.kind === "box" && cfg.box?.shared === true,
      ...(boxMaintenance(computers.defaultRemote())
        ? { cleanup: boxMaintenance(computers.defaultRemote())! }
        : {}),
    }),
  ];
  const gatedRoutes: RouteHandler[] =
    auth.mode === "desktop"
      ? desktopRoutes
      : [
          createOAuthRoutes({
            applicationOrigin: authentication.mode === "saas" ? authentication.applicationOrigin : "",
            provider: auth.oauthProvider,
            transactions: new OAuthTransactionStore(repos.db),
            sessions: identitySessions!,
            audit: securityAudit!,
            now: () => clock.now(),
          }),
          createSessionRoutes(),
          createSaasBotCatalogRoutes({ bots, audit: securityAudit! }),
          createSaasDesktopAccessRoutes({
            forOwner: (ownerId) => desktopAccessGrants!.forOwner(ownerId),
            viewerForOwner: (ownerId) => desktopViewerBroker!.forOwner(ownerId),
            now: () => clock.now(),
          }),
          createHealthRoutes({ staticServing: Boolean(staticDir), stamp }),
        ];

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    const ctx: RouteCtx = { req, res, url, path: url.pathname, method: req.method ?? "GET" };
    try {
      if (await integrations.internal(ctx)) return;

      // ── mode-aware gate for everything else under /api ────────────────
      // Desktop retains launch bearer + loopback Host/Origin checks. SaaS
      // accepts only a server-side session and exact configured HTTPS Origin
      // for state changes. /api/health remains the minimal startup probe.
      if (ctx.path.startsWith("/api/")) {
        const decision = authenticateApiRequest(
          {
            path: ctx.path,
            method: ctx.method,
            headers: {
              authorization: req.headers.authorization,
              cookie: req.headers.cookie,
              host: req.headers.host,
              origin: typeof req.headers.origin === "string" ? req.headers.origin : undefined,
            },
          },
          authentication,
        );
        if (!decision.ok) return json(res, decision.failure.status, { error: decision.failure.error });
        if (decision.principal) ctx.principal = decision.principal;
      }

      for (const route of gatedRoutes) {
        if (await route(ctx)) return;
      }

      // packaged app: the server serves the built UI too (window → :8799 for
      // everything, no dev proxy to die). OMB_STATIC_DIR is set by Electron.
      if (ctx.method === "GET" && !ctx.path.startsWith("/api/") && staticDir) {
        const safe = ctx.path === "/" ? "/index.html" : ctx.path.replace(/\.\./g, "");
        const file = join(staticDir, safe);
        try {
          const data = readFileSync(file);
          res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
          res.end(data);
          return;
        } catch {
          // SPA fallback
          try {
            const data = readFileSync(join(staticDir, "index.html"));
            res.writeHead(200, { "content-type": "text/html" });
            res.end(data);
            return;
          } catch {
            /* fall through to 404 */
          }
        }
      }

      return json(res, 404, { error: `no route: ${ctx.method} ${ctx.path}` });
    } catch (e) {
      // In SaaS, thrown values and status metadata are untrusted. Bounded
      // client errors must be written by their route before they reach this
      // application-level boundary; everything else fails closed.
      if (auth.mode === "saas") return json(res, 500, { error: "internal server error" });
      const status = (e as { status?: number })?.status ?? 500;
      return json(res, status, { error: e instanceof Error ? e.message : String(e) });
    }
  }

  return {
    handle,
    tick(now = clock.now()) {
      routines.tick(now);
      proactive.tick(now);
    },
    hub,
    services: { bots, groups, turns, routines, teach, proactive, telegram, discord, channels },
  };
}
