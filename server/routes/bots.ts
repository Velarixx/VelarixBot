// Bots CRUD (+ cards, per-bot memory, taught skills, teach sessions).
import { parseAllowedToolkits } from "../composio-filter.ts";
import type { ComputerRegistry } from "../computer/registry.ts";
import type { AppConfig } from "../config.ts";
import type { ProviderRegistry } from "../harness/registry.ts";
import {
  deleteMemoryRow,
  editMemoryRow,
  forgetEverything,
  insertMemoryRow,
  isMemoryRowType,
  listMemoryRows,
  pinMemoryRow,
  readBotMemory,
  readWorkspace,
  writeBotMemory,
  writeWorkspace,
} from "../memory.ts";
import type { Broadcast } from "../services/events.ts";
import type { BotsService } from "../services/bots.ts";
import type { RoutinesService } from "../services/routines.ts";
import type { TeachService } from "../services/teach.ts";
import type { TurnsService } from "../services/turns.ts";
import { acceptSuggestion, isSuggestionAccept, isSuggestionCard } from "../suggestions.ts";
import { deleteSkill, getRecordingSession, getSkill, listTeachSessions, loadSkills, saveSkill } from "../teach.ts";
import { json, readBody, type RouteHandler } from "./context.ts";

export function createBotsRoutes(deps: {
  bots: BotsService;
  turns: TurnsService;
  teach: TeachService;
  routines: RoutinesService;
  registry: ProviderRegistry;
  computers: ComputerRegistry;
  cfg: AppConfig;
  broadcast: Broadcast;
}): RouteHandler {
  const { bots, turns, teach, routines, registry, computers, cfg, broadcast } = deps;
  return async ({ req, res, path, method }) => {
    // ── per-bot + shared workspace memory (markdown + structured rows) ──
    const memoryMatch = path.match(/^\/api\/bots\/([\w-]+)\/memory$/);
    const memoryForget = path.match(/^\/api\/bots\/([\w-]+)\/memory\/forget$/);
    const memoryRows = path.match(/^\/api\/bots\/([\w-]+)\/memory\/rows$/);
    const memoryRow = path.match(/^\/api\/bots\/([\w-]+)\/memory\/rows\/([\w-]+)$/);
    if (memoryForget && method === "POST") {
      if (!bots.bot(memoryForget[1])) {
        json(res, 404, { error: "no such bot" });
        return true;
      }
      const body = await readBody(req);
      const scope = body.workspace === true || body.scope === "workspace" ? "workspace" : "bot";
      forgetEverything(memoryForget[1], scope);
      json(res, 200, { ok: true, scope, rows: listMemoryRows(memoryForget[1]) });
      return true;
    }
    if (memoryRows && method === "POST") {
      if (!bots.bot(memoryRows[1])) {
        json(res, 404, { error: "no such bot" });
        return true;
      }
      const body = await readBody(req);
      const type = String(body.type ?? "");
      const text = String(body.text ?? "");
      if (!isMemoryRowType(type)) {
        json(res, 400, { error: "type must be preference, fact, or workflow" });
        return true;
      }
      try {
        const row = insertMemoryRow({ botId: memoryRows[1], type, text, pinned: body.pinned === true });
        json(res, 201, { row });
      } catch (e) {
        json(res, 400, { error: e instanceof Error ? e.message : "could not save row" });
      }
      return true;
    }
    if (memoryRow && (method === "PATCH" || method === "PUT")) {
      if (!bots.bot(memoryRow[1])) {
        json(res, 404, { error: "no such bot" });
        return true;
      }
      const body = await readBody(req);
      let row = listMemoryRows(memoryRow[1]).find((r) => r.id === memoryRow[2]) ?? null;
      if (!row) {
        json(res, 404, { error: "no such memory row" });
        return true;
      }
      if (typeof body.text === "string") row = editMemoryRow(memoryRow[2], body.text) ?? row;
      if (typeof body.pinned === "boolean") row = pinMemoryRow(memoryRow[2], body.pinned) ?? row;
      json(res, 200, { row });
      return true;
    }
    if (memoryRow && method === "DELETE") {
      if (!bots.bot(memoryRow[1])) {
        json(res, 404, { error: "no such bot" });
        return true;
      }
      if (!deleteMemoryRow(memoryRow[2])) {
        json(res, 404, { error: "no such memory row" });
        return true;
      }
      json(res, 200, { ok: true });
      return true;
    }
    if (memoryMatch && method === "GET") {
      if (!bots.bot(memoryMatch[1])) {
        json(res, 404, { error: "no such bot" });
        return true;
      }
      const botMem = readBotMemory(memoryMatch[1]);
      json(res, 200, {
        user: botMem.user,
        distilled: botMem.distilled,
        workspace: readWorkspace(),
        rows: listMemoryRows(memoryMatch[1]),
      });
      return true;
    }
    if (memoryMatch && (method === "PUT" || method === "PATCH")) {
      if (!bots.bot(memoryMatch[1])) {
        json(res, 404, { error: "no such bot" });
        return true;
      }
      const body = await readBody(req);
      const hasUser = typeof body.user === "string";
      const hasDistilled = typeof body.distilled === "string";
      const hasWorkspace = typeof body.workspace === "string";
      if (!hasUser && !hasDistilled && !hasWorkspace) {
        json(res, 400, { error: "nothing to save" });
        return true;
      }
      if (hasUser || hasDistilled) {
        const existing = readBotMemory(memoryMatch[1]);
        writeBotMemory(memoryMatch[1], {
          user: hasUser ? body.user : existing.user,
          distilled: hasDistilled ? body.distilled : existing.distilled,
        });
      }
      if (hasWorkspace) writeWorkspace(body.workspace);
      const botMem = readBotMemory(memoryMatch[1]);
      json(res, 200, {
        user: botMem.user,
        distilled: botMem.distilled,
        workspace: readWorkspace(),
        rows: listMemoryRows(memoryMatch[1]),
      });
      return true;
    }

    // ── taught skills ──
    if (method === "GET" && path === "/api/skills") {
      json(res, 200, { skills: loadSkills() });
      return true;
    }
    if (method === "POST" && path === "/api/skills") {
      const body = await readBody(req);
      const skill = saveSkill({
        name: String(body.name ?? ""),
        botId: String(body.botId ?? ""),
        markdown: String(body.markdown ?? ""),
        id: typeof body.id === "string" ? body.id : undefined,
      });
      json(res, 201, { skill });
      return true;
    }
    const skillMatch = path.match(/^\/api\/skills\/([\w-]+)$/);
    if (skillMatch && method === "GET") {
      const skill = getSkill(skillMatch[1]);
      if (skill) json(res, 200, { skill });
      else json(res, 404, { error: "no such skill" });
      return true;
    }
    if (skillMatch && method === "PATCH") {
      const existing = getSkill(skillMatch[1]);
      if (!existing) {
        json(res, 404, { error: "no such skill" });
        return true;
      }
      const body = await readBody(req);
      const skill = saveSkill({
        id: existing.id,
        name: String(body.name ?? existing.name),
        botId: String(body.botId ?? existing.botId),
        markdown: String(body.markdown ?? existing.markdown),
      });
      json(res, 200, { skill });
      return true;
    }
    if (skillMatch && method === "DELETE") {
      if (!deleteSkill(skillMatch[1])) {
        json(res, 404, { error: "no such skill" });
        return true;
      }
      bots.clearSkillRefs(skillMatch[1]);
      json(res, 200, { ok: true });
      return true;
    }

    if (method === "GET" && path === "/api/teach-sessions") {
      json(res, 200, { sessions: listTeachSessions() });
      return true;
    }
    let teachMatch = path.match(/^\/api\/bots\/([\w-]+)\/teach\/(start|stop)$/);
    if (teachMatch && method === "POST") {
      if (teachMatch[2] === "start") {
        json(res, 200, teach.startTeachSession(teachMatch[1]));
        return true;
      }
      const body = await readBody(req).catch(() => ({}));
      json(res, 200, await teach.stopTeachSession(teachMatch[1], typeof body.name === "string" ? body.name : undefined));
      return true;
    }
    teachMatch = path.match(/^\/api\/bots\/([\w-]+)\/teach$/);
    if (teachMatch && method === "GET") {
      if (!bots.bot(teachMatch[1])) {
        json(res, 404, { error: "no such bot" });
        return true;
      }
      json(res, 200, { session: getRecordingSession(teachMatch[1]), sessions: listTeachSessions(teachMatch[1]) });
      return true;
    }

    // ── bots ──
    if (method === "GET" && path === "/api/bots") {
      json(res, 200, {
        bots: bots.bots().map((b) => ({ ...b, messages: bots.messagesFor(b.threadId) })),
      });
      return true;
    }
    if (method === "POST" && path === "/api/bots") {
      const bot = await turns.createSidebarBot();
      json(res, 201, { bot });
      return true;
    }
    let m = path.match(/^\/api\/bots\/([\w-]+)$/);
    if (m && method === "PATCH") {
      const body = await readBody(req);
      const patch: Record<string, unknown> = {};
      for (const key of ["name", "title", "description", "notifications", "notifyEvents", "modelSelection", "unread", "computer", "color", "mascotExpression", "mascotPinned", "iconShape", "avatarNonce", "pinned", "hidden", "requireApproval", "alwaysAllow", "enabledApps", "skillId", "threadParticipants"] as const) {
        if (body[key] !== undefined) patch[key] = body[key];
      }
      if (patch.enabledApps !== undefined) patch.enabledApps = parseAllowedToolkits(patch.enabledApps);
      // bot.computer is a provider BINDING — canonicalize (legacy "cloud" →
      // the bundled box binding) and reject anything not registered, so a
      // removed provider is an explicit 409, never a silent failover
      if (patch.computer !== undefined) {
        const binding = computers.resolveBinding(patch.computer);
        if (!binding) {
          json(res, 409, { error: `unknown computer provider "${String(patch.computer)}" — configure it in ~/.velarixbot/config.json, or choose local/off` });
          return true;
        }
        patch.computer = binding;
      }
      if (patch.computer === "local" && process.env.OMB_LOCAL_CUA_SUPPORTED === "0") {
        json(res, 409, { error: "local computer control is not available on Windows; choose Cloud box or Off" });
        return true;
      }
      // Same unsafe-combination rule as provider full-auto: a bot allowed to
      // act without cards must not be driving THIS machine.
      {
        const current = bots.bot(m[1]);
        const effectiveComputer = (patch.computer ?? current?.computer) as string | undefined;
        const effectiveAlwaysAllow = patch.alwaysAllow !== undefined ? patch.alwaysAllow === true : current?.alwaysAllow === true;
        if (effectiveComputer === "local" && effectiveAlwaysAllow) {
          json(res, 409, { error: "unsafe configuration: local computer cannot be combined with Always allow" });
          return true;
        }
      }
      if (patch.computer === "local" || (patch.modelSelection && bots.bot(m[1])?.computer === "local")) {
        const current = bots.bot(m[1]);
        const selected = (patch.modelSelection ?? current?.modelSelection) as { instanceId?: string } | undefined;
        const configured = selected?.instanceId ? cfg.instances?.[selected.instanceId] : undefined;
        if (configured?.config && typeof configured.config === "object" && (configured.config as { fullAuto?: unknown }).fullAuto === true) {
          json(res, 409, { error: "unsafe configuration: local computer cannot be combined with provider full-auto" });
          return true;
        }
        const selectedInstance = selected?.instanceId ? registry.get(selected.instanceId) : undefined;
        if (selectedInstance && selectedInstance.adapter.capabilities.localComputerMcp !== true) {
          json(res, 409, { error: "selected provider does not support guarded local computer control" });
          return true;
        }
      }
      // Remote mirror of the local 409: a bot whose EFFECTIVE binding is a
      // remote computer provider must sit on a driver that can actually
      // mount/act on that machine.
      {
        const current = bots.bot(m[1]);
        const effectiveComputer = (patch.computer ?? current?.computer) as string | undefined;
        const remote = effectiveComputer && effectiveComputer !== "off" && effectiveComputer !== "local"
          ? computers.get(effectiveComputer)
          : null;
        if (remote && (patch.computer !== undefined || patch.modelSelection)) {
          const selected = (patch.modelSelection ?? current?.modelSelection) as { instanceId?: string } | undefined;
          const selectedInstance = selected?.instanceId ? registry.get(selected.instanceId) : undefined;
          if (selectedInstance && selectedInstance.adapter.capabilities.cloudComputer !== true) {
            json(res, 409, { error: "selected provider has no cloud computer tools — pick Claude, Codex, or the Computer engine, or set computer to off" });
            return true;
          }
        }
      }
      const bot = bots.patchBot(m[1], patch);
      if (!bot) {
        json(res, 404, { error: "no such bot" });
        return true;
      }
      broadcast({ kind: "bot", bot });
      json(res, 200, { bot });
      return true;
    }
    m = path.match(/^\/api\/bots\/([\w-]+)$/);
    if (m && method === "DELETE") {
      const removed = await turns.removeSidebarBot(m[1]);
      if ("error" in removed) json(res, removed.status, { error: removed.error });
      else json(res, 200, { ok: true });
      return true;
    }

    // onboarding/ask cards persist their answered/dismissed state
    m = path.match(/^\/api\/bots\/([\w-]+)\/cards\/([\w-]+)$/);
    if (m && method === "PATCH") {
      const bot = bots.bot(m[1]);
      if (!bot) {
        json(res, 404, { error: "no such bot" });
        return true;
      }
      const existing = bots.messagesFor(bot.threadId).find((msg) => msg.id === m![2]);
      if (!existing?.card) {
        json(res, 404, { error: "no such card" });
        return true;
      }
      const body = await readBody(req);
      const answered = typeof body.answered === "string" ? body.answered : undefined;
      const dismissed = body.dismissed === true;
      // Suggestion cards write only on an explicit accept of THIS bot's
      // card. Dismiss / already-settled / cross-bot persist the card and
      // nothing else — not a routine, not a memory row, not Allow-always.
      if (
        isSuggestionCard(existing.card) &&
        !existing.card.answered &&
        !existing.card.dismissed &&
        !dismissed &&
        answered &&
        existing.card.suggestion &&
        isSuggestionAccept(existing.card, answered)
      ) {
        const result = acceptSuggestion({
          botId: bot.id,
          suggestion: existing.card.suggestion,
          createRoutine: (input) => routines.createRoutine(input),
        });
        if (result.kind === "routine") broadcast({ kind: "routine", routine: result.routine });
      }
      const patched = bots.patchMessage(bot.threadId, m[2], {
        card: {
          ...existing.card,
          ...(answered !== undefined ? { answered } : {}),
          ...(body.dismissed !== undefined ? { dismissed: body.dismissed } : {}),
        },
      });
      broadcast({ kind: "message.patch", threadId: bot.threadId, message: patched });
      json(res, 200, { message: patched });
      return true;
    }
    return false;
  };
}
