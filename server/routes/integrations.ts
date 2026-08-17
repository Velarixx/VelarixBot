// Integrations surface:
//   - /api/internal/* — localhost peer-agent comms + workspace/memory tools
//     (guarded by the per-boot COMMS token, not the public API token)
//   - /api/instances — the provider fleet for the model picker
//   - /api/config — API keys, write-only (booleans out, never values)
//   - /api/connectors — Composio catalog + per-service connect state
import {
  COMMS_DEPTH_ERROR,
  MAX_COMMS_DEPTH,
  commsGuard,
  parseVisited,
  uniqueIds,
} from "../comms.ts";
import { bindCommsStore, getOrCreateChannel, mirrorExchange, mirrorReply } from "../comms-visibility.ts";
import * as composio from "../composio.ts";
import {
  composioConfigured,
  composioSessionKey,
  createSession,
  publicSessions,
  revokeSession,
  sessionUserId,
} from "../composio-sessions.ts";
import type { AppConfig } from "../config.ts";
import { loadConfig, persistableFleet, saveConfig } from "../config.ts";
import { MAX_DELEGATION_DEPTH, queueDelegation } from "../delegations.ts";
import type { ProviderRegistry } from "../harness/registry.ts";
import { recallMemory, rememberNote } from "../memory.ts";
import type { Broadcast } from "../services/events.ts";
import type { BotsService } from "../services/bots.ts";
import type { GroupsService } from "../services/groups.ts";
import type { TurnsService } from "../services/turns.ts";
import { json, readBody, type RouteHandler } from "./context.ts";

export interface IntegrationsRoutes {
  /** /api/internal/* — runs BEFORE the public launch-token gate; guarded by
   * the per-boot comms token instead. */
  internal: RouteHandler;
  /** /api/instances, /api/config, /api/connectors — behind the token gate. */
  api: RouteHandler;
}

export function createIntegrationsRoutes(deps: {
  bots: BotsService;
  groups: GroupsService;
  turns: TurnsService;
  registry: ProviderRegistry;
  cfg: AppConfig;
  commsToken: string;
  broadcast: Broadcast;
  reloadProviders(): Promise<void>;
}): IntegrationsRoutes {
  const { bots, groups, turns, registry, cfg, commsToken, broadcast, reloadProviders } = deps;
  const commsBus = { store: bindCommsStore(bots, groups), broadcast };

  function configStatus() {
    return {
      xai: { configured: Boolean(cfg.xai?.key) },
      composio: {
        configured: composioConfigured(cfg),
        apiKeyConfigured: Boolean(cfg.composio?.apiKey),
        connectKeyConfigured: Boolean(cfg.composio?.key),
      },
      // shared/namePrefix are settings, not secrets — echoed only when set
      // so the default shape (and its consumers) stays byte-identical
      box: {
        configured: Boolean(cfg.box?.token),
        ...(cfg.box?.shared === true ? { shared: true } : {}),
        ...(typeof cfg.box?.namePrefix === "string" && cfg.box.namePrefix ? { namePrefix: cfg.box.namePrefix } : {}),
      },
      github: { configured: Boolean(cfg.github?.token) },
      openai: { configured: Boolean(cfg.openai?.key) },
      openrouter: { configured: Boolean(cfg.openrouter?.key) },
      omnirouter: { configured: Boolean(cfg.omnirouter?.key) },
    };
  }

  // ── internal peer-agent comms (localhost + shared token only) ──────
  // The agents-proxy (spawned inside a bot's agent process) calls these to
  // discover peers and hand a message to one. Not part of the public API.
  const internal: RouteHandler = async ({ req, res, url, path, method }) => {
    if (path.startsWith("/api/internal/")) {
      if (req.headers.authorization !== `Bearer ${commsToken}`) {
        json(res, 401, { error: "unauthorized" });
        return true;
      }
      if (method === "GET" && path === "/api/internal/agents") {
        const self = url.searchParams.get("self");
        const list = bots
          .bots()
          .filter((b) => b.id !== self && !b.hidden)
          .map((b) => ({ id: b.id, name: b.name, model: b.modelSelection.model, busy: !!b.busy }));
        json(res, 200, { bots: list });
        return true;
      }
      if (method === "POST" && path === "/api/internal/ask-bot") {
        const body = await readBody(req);
        const fromBotId = String(body.fromBotId ?? "");
        const toBotId = String(body.toBotId ?? "");
        const message = String(body.message ?? "").trim();
        const depth = Number(body.depth ?? 0) || 0;
        const visited = parseVisited(body.visited ?? body.visitedIds);
        if (!toBotId || !message) {
          json(res, 400, { error: "toBotId and message required" });
          return true;
        }
        const guard = commsGuard(fromBotId, toBotId, depth, visited);
        if (!guard.ok) {
          json(res, 200, { error: guard.error });
          return true;
        }
        const target = bots.bot(toBotId);
        if (!target) {
          json(res, 404, { error: "no such bot" });
          return true;
        }
        const from = bots.bot(fromBotId);
        const fromName = from?.name ?? "another bot";
        const groupThreadId =
          (typeof body.groupThreadId === "string" && body.groupThreadId.trim()) || from?.threadId || undefined;
        if (from && groupThreadId) {
          bots.patchBot(from.id, {
            threadParticipants: uniqueIds([from.id, ...(from.threadParticipants ?? []), toBotId]),
          });
          broadcast({ kind: "bot", bot: bots.publicBot(from.id) });
        }
        const channel = from ? getOrCreateChannel(commsBus.store, from, target) : undefined;
        if (from && channel) {
          broadcast({ kind: "group", group: groups.publicGroup(channel.id) ?? channel });
          mirrorExchange(commsBus, from, target, message, channel, from.threadId);
        }
        const prefixed = `[Message from @${fromName}, another bot in this VelarixBot workspace. Reply to them.]\n\n${message}`;
        const reply = await turns.askBotQueued(toBotId, prefixed, depth, {
          visited: guard.chain,
          groupThreadId,
          fromBotId,
        });
        if (from && channel) mirrorReply(commsBus, target, reply, channel);
        json(res, 200, { botName: target.name, text: reply });
        return true;
      }
      if (method === "POST" && path === "/api/internal/delegate-bot") {
        const body = await readBody(req);
        const fromBotId = String(body.fromBotId ?? "");
        const toBotId = String(body.toBotId ?? "");
        const message = String(body.message ?? "").trim();
        const reason = typeof body.reason === "string" ? body.reason.trim() : "";
        const depth = Number(body.depth ?? 0) || 0;
        if (!toBotId || !message) {
          json(res, 400, { error: "toBotId and message required" });
          return true;
        }
        const from = bots.bot(fromBotId);
        if (!from) {
          json(res, 404, { error: "no such bot" });
          return true;
        }
        const result = queueDelegation(
          commsBus,
          from,
          { toBotId, message, depth, ...(reason ? { reason } : {}) },
          MAX_DELEGATION_DEPTH,
        );
        if (result === "self") {
          json(res, 200, { error: "a bot cannot message itself" });
          return true;
        }
        if (result === "too_deep") {
          json(res, 200, { error: COMMS_DEPTH_ERROR });
          return true;
        }
        if (result === "no_target") {
          json(res, 404, { error: "no such bot" });
          return true;
        }
        if (result === "too_many") {
          json(res, 200, { error: "too many queued delegations" });
          return true;
        }
        json(res, 200, { message: "Delegation queued." });
        return true;
      }
      if (method === "POST" && path === "/api/internal/create-bot") {
        const body = await readBody(req);
        const fromBotId = String(body.fromBotId ?? "");
        const name = String(body.name ?? "").trim();
        const title = String(body.title ?? "").trim();
        const description = String(body.description ?? "").trim();
        const model = String(body.model ?? "").trim();
        const depth = Number(body.depth ?? 0) || 0;
        if (!name || !title || !description) {
          json(res, 400, { error: "name, title, and description required" });
          return true;
        }
        if (depth >= MAX_COMMS_DEPTH) {
          json(res, 200, { error: COMMS_DEPTH_ERROR });
          return true;
        }
        const created = await turns.createSidebarBot({ name, title, description, ...(model ? { model } : {}), computer: "cloud" });
        const from = bots.bot(fromBotId);
        if (from) {
          const note = bots.appendMessage(from.threadId, {
            role: "bot",
            kind: "activity",
            tool: { name: `created @${created.name}` },
          });
          broadcast({ kind: "message", threadId: from.threadId, message: note });
        }
        json(res, 200, {
          bot: { id: created.id, name: created.name, title: created.title, description: created.description, model: created.modelSelection.model, computer: created.computer },
        });
        return true;
      }
      if (method === "POST" && path === "/api/internal/delete-bot") {
        const body = await readBody(req);
        const targetId = String(body.bot_id ?? body.botId ?? "").trim();
        const depth = Number(body.depth ?? 0) || 0;
        if (!targetId) {
          json(res, 400, { error: "bot_id required" });
          return true;
        }
        if (depth >= MAX_COMMS_DEPTH) {
          json(res, 200, { error: COMMS_DEPTH_ERROR });
          return true;
        }
        const fromBotId = String(body.fromBotId ?? "");
        const from = bots.bot(fromBotId);
        const removed = await turns.removeSidebarBot(targetId);
        if ("error" in removed) {
          if (removed.status === 404) json(res, 404, { error: removed.error });
          else json(res, 200, { error: removed.error });
          return true;
        }
        if (from && from.id !== removed.bot.id) {
          const note = bots.appendMessage(from.threadId, {
            role: "bot",
            kind: "activity",
            tool: { name: `removed @${removed.bot.name}` },
          });
          broadcast({ kind: "message", threadId: from.threadId, message: note });
        }
        json(res, 200, { id: removed.bot.id, name: removed.bot.name });
        return true;
      }
      if (method === "POST" && path === "/api/internal/update-bot") {
        const body = await readBody(req);
        const targetId = String(body.bot_id ?? body.botId ?? "").trim();
        const depth = Number(body.depth ?? 0) || 0;
        if (!targetId) {
          json(res, 400, { error: "bot_id required" });
          return true;
        }
        if (depth >= MAX_COMMS_DEPTH) {
          json(res, 200, { error: COMMS_DEPTH_ERROR });
          return true;
        }
        const target = bots.bot(targetId);
        if (!target) {
          json(res, 404, { error: "no such bot" });
          return true;
        }
        const patch: { name?: string; title?: string; description?: string; alwaysAllow?: boolean } = {};
        if (typeof body.name === "string" && body.name.trim()) patch.name = body.name.trim();
        if (typeof body.title === "string") patch.title = body.title;
        if (typeof body.description === "string") patch.description = body.description;
        if (typeof body.always_allow === "boolean") patch.alwaysAllow = body.always_allow;
        if (!Object.keys(patch).length) {
          json(res, 400, { error: "name, title, description, or always_allow required" });
          return true;
        }
        // same unsafe-combination rule as the public PATCH route
        if (patch.alwaysAllow === true && target.computer === "local") {
          json(res, 409, { error: "unsafe configuration: local computer cannot be combined with Always allow" });
          return true;
        }
        const updated = bots.patchBot(targetId, patch);
        if (!updated) {
          json(res, 404, { error: "no such bot" });
          return true;
        }
        broadcast({ kind: "bot", bot: bots.publicBot(updated.id) ?? updated });
        const from = bots.bot(String(body.fromBotId ?? ""));
        if (from) {
          const note = bots.appendMessage(from.threadId, {
            role: "bot",
            kind: "activity",
            tool: { name: `updated @${updated.name}` },
          });
          broadcast({ kind: "message", threadId: from.threadId, message: note });
        }
        json(res, 200, { id: updated.id, name: updated.name, title: updated.title, description: updated.description, always_allow: updated.alwaysAllow === true });
        return true;
      }
      if (method === "POST" && path === "/api/internal/workspace") {
        const body = await readBody(req);
        const fromBotId = String(body.fromBotId ?? "");
        const tool = String(body.tool ?? "").trim();
        const depth = Number(body.depth ?? 0) || 0;
        const args = body.args && typeof body.args === "object" && !Array.isArray(body.args) ? (body.args as Record<string, unknown>) : {};
        if (!tool) {
          json(res, 400, { error: "tool required" });
          return true;
        }
        const result = await turns.handleWorkspaceTool(fromBotId, tool, args, depth);
        if (result.error) json(res, 200, { error: result.error });
        else json(res, 200, { text: result.text });
        return true;
      }
      if (method === "POST" && path === "/api/internal/remember") {
        const body = await readBody(req);
        const fromBotId = String(body.fromBotId ?? "");
        const note = String(body.note ?? "").trim();
        const scope = body.scope === "workspace" ? "workspace" : "bot";
        if (!fromBotId || !bots.bot(fromBotId)) {
          json(res, 404, { error: "no such bot" });
          return true;
        }
        if (!note) {
          json(res, 400, { error: "note required" });
          return true;
        }
        rememberNote(fromBotId, note, scope);
        json(res, 200, { ok: true, scope });
        return true;
      }
      if (method === "POST" && path === "/api/internal/recall") {
        const body = await readBody(req);
        const fromBotId = String(body.fromBotId ?? "");
        const query = typeof body.query === "string" ? body.query : undefined;
        if (!fromBotId || !bots.bot(fromBotId)) {
          json(res, 404, { error: "no such bot" });
          return true;
        }
        json(res, 200, { text: recallMemory(fromBotId, query) });
        return true;
      }
      json(res, 404, { error: "unknown internal endpoint" });
      return true;
    }
    return false;
  };

  const api: RouteHandler = async ({ req, res, url, path, method }) => {
    // ── provider instances (model picker) ──
    if (method === "GET" && path === "/api/instances") {
      json(res, 200, { instances: await registry.describe() });
      return true;
    }
    // Per-engine CLI path. Instance-level only — never a per-bot override.
    // Materialize the full persistable fleet so a single { cli } cannot
    // replace the default map (instanceConfigs treats a non-empty authored
    // map as a full replacement).
    const instancePatch = method === "PATCH" && path.match(/^\/api\/instances\/([^/]+)$/);
    if (instancePatch) {
      const id = decodeURIComponent(instancePatch[1] ?? "");
      const body = await readBody(req);
      if (typeof body.cli !== "string") {
        json(res, 400, { error: "cli must be a string" });
        return true;
      }
      const fleet = persistableFleet(cfg);
      if (!fleet[id]) {
        json(res, 404, { error: "no such instance" });
        return true;
      }
      const prev = fleet[id];
      const prevConfig =
        prev.config && typeof prev.config === "object" && !Array.isArray(prev.config)
          ? { ...(prev.config as Record<string, unknown>) }
          : {};
      const cli = body.cli.trim();
      if (cli) prevConfig.cli = cli;
      else delete prevConfig.cli;
      fleet[id] = { ...prev, config: prevConfig };
      await saveConfig({ instances: fleet });
      Object.assign(cfg, loadConfig());
      await reloadProviders();
      json(res, 200, { instances: await registry.describe() });
      return true;
    }

    // ── app config (API keys — never echoed back, booleans only) ──
    if (method === "GET" && path === "/api/config") {
      json(res, 200, configStatus());
      return true;
    }
    if ((method === "PUT" || method === "PATCH") && path === "/api/config") {
      const body = await readBody(req);
      const patch: Record<string, object> = {};
      for (const key of ["xai", "composio", "box", "github", "openai", "openrouter", "omnirouter"] as const) {
        if (body[key] && typeof body[key] === "object") patch[key] = body[key];
      }
      if (!Object.keys(patch).length) {
        json(res, 400, { error: "nothing to save" });
        return true;
      }
      // shared-box knobs are strict-decoded at provider create; reject bad
      // types at the door so a Settings save cannot shadow the provider
      if (patch.box) {
        const b = patch.box as Record<string, unknown>;
        const bad =
          (b.shared !== undefined && typeof b.shared !== "boolean" && "box.shared must be a boolean") ||
          (b.namePrefix !== undefined && typeof b.namePrefix !== "string" && "box.namePrefix must be a string") ||
          (b.leaseWaitMs !== undefined &&
            (typeof b.leaseWaitMs !== "number" || !Number.isFinite(b.leaseWaitMs) || b.leaseWaitMs <= 0) &&
            "box.leaseWaitMs must be a positive number of milliseconds");
        if (bad) {
          json(res, 400, { error: bad });
          return true;
        }
      }
      await saveConfig(patch);
      Object.assign(cfg, loadConfig());
      await reloadProviders();
      const status = configStatus();
      broadcast({ kind: "config", ...status });
      json(res, 200, status);
      return true;
    }

    // ── connectors (Composio) ──
    if (method === "GET" && path === "/api/connectors/catalog") {
      const { cards, source } = await composio.listToolkits(cfg);
      json(res, 200, { configured: composioConfigured(cfg), source, cards });
      return true;
    }
    if (method === "GET" && path === "/api/connectors/sessions") {
      json(res, 200, {
        configured: Boolean(composioSessionKey(cfg)),
        sessions: publicSessions(),
      });
      return true;
    }
    if (method === "POST" && path === "/api/connectors/sessions") {
      if (!composioSessionKey(cfg)) {
        json(res, 200, { configured: false, error: "no Composio API key — Sessions need an ak_ key, not a Connect ck_" });
        return true;
      }
      const body = await readBody(req);
      const botId = String(body.botId ?? "").trim();
      if (!botId || !bots.bot(botId)) {
        json(res, 404, { error: "no such bot" });
        return true;
      }
      const bot = bots.bot(botId)!;
      const mcp = await createSession(cfg, botId, bot.enabledApps ?? []);
      json(res, 200, { session: { botId, userId: mcp.userId, sessionId: mcp.sessionId } });
      return true;
    }
    let sessionRevoke = path.match(/^\/api\/connectors\/sessions\/([\w-]+)$/);
    if (sessionRevoke && method === "DELETE") {
      json(res, 200, await revokeSession(cfg, sessionRevoke[1]));
      return true;
    }
    if (method === "GET" && path === "/api/connectors") {
      const services = (url.searchParams.get("services") ?? "").split(",").filter(Boolean);
      const botId = url.searchParams.get("botId") || undefined;
      if (!composioConfigured(cfg)) {
        json(res, 200, { configured: false, services: {} });
        return true;
      }
      const status = await composio.connectionStatus(cfg, services.length ? services : composio.CURATED_SLUGS, botId);
      json(res, 200, { configured: true, services: status });
      return true;
    }
    let m = path.match(/^\/api\/connectors\/([\w-]+)\/authorize$/);
    if (m && method === "POST") {
      const body = await readBody(req);
      const botId = typeof body.botId === "string" ? body.botId : url.searchParams.get("botId") || undefined;
      json(res, 200, await composio.authorizeService(cfg, m[1], botId));
      return true;
    }
    m = path.match(/^\/api\/connectors\/([\w-]+)$/);
    if (m && method === "DELETE") {
      const botId = url.searchParams.get("botId") || undefined;
      json(res, 200, await composio.removeService(cfg, m[1], botId));
      return true;
    }
    return false;
  };

  return { internal, api };
}
