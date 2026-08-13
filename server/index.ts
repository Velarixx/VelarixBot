// VelarixBot server — the harness host. Clients hold no transports
// (upstream rule): the React app dispatches typed commands over HTTP and
// folds one SSE event stream; every provider process runs here.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { attachmentPathRefs, expandAttachmentPaths } from "./attachments.ts";
import { alwaysAllow, resolveOpenedRequest } from "./approvals.ts";
import * as box from "./box.ts";
import * as composio from "./composio.ts";
import { parseAllowedToolkits } from "./composio-filter.ts";
import {
  ASK_BUDGET_MS,
  COMMS_DEPTH_ERROR,
  MAX_COMMS_DEPTH,
  commsGuard,
  parseVisited,
  uniqueIds,
} from "./comms.ts";
import { ensureDirs, instanceConfigs, loadConfig, saveConfig, EVENTS_DIR, NATIVE_DIR } from "./config.ts";
import type { RuntimeEvent } from "./contracts.ts";

import { BUILT_IN_DRIVERS } from "./drivers/builtIn.ts";
import { EventBus } from "./harness/bus.ts";
import { ProviderRegistry } from "./harness/registry.ts";
import { HANDOFF_CONTINUE, HANDOFF_SUBTITLE, HANDOFF_TITLE, sanitizeHandoffSummary } from "./handoff.ts";
import { deleteBotMemory, distillMemory, memoryPrompt, turnTextFromMessages } from "./memory.ts";
import { createPeerQueue } from "./peer-queue.ts";
import { createProactive } from "./proactive.ts";
import { parseResponseOptions, responseOptionsPrompt, shouldAttachResponseOptions } from "./response-options.ts";
import { mentionedBots, nextRunAt, Store, type Message, type Usage } from "./store.ts";
import {
  deleteSkillsForBot,
  distillSkill,
  getSkill,
  loadSkills,
  saveSkill,
  deleteSkill,
  skillPrompt,
  type TeachEvent,
  type TeachFrame,
} from "./teach.ts";

const PORT = Number(process.env.OMB_PORT || process.env.OGB_PORT || 8799);
const STATIC_DIR = process.env.OMB_STATIC_DIR || null;
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

ensureDirs();
const cfg = loadConfig();
const registry = new ProviderRegistry(BUILT_IN_DRIVERS);
await registry.load(instanceConfigs(cfg));

const bus = new EventBus();
bus.attach(registry.instances());

// ── peer-agent comms wiring ────────────────────────────────────────────
// A shared secret guards the localhost-only /api/internal endpoints the
// agents-proxy calls; regenerated each boot (the proxy gets it via env).
const COMMS_TOKEN = process.env.OMB_COMMS_TOKEN || randomBytes(24).toString("hex");
// Cap message chains: depth 0 = a user-initiated turn (may ask a peer);
// a peer invoked via ask_bot runs at depth 1 and may ask once more;
// depth 2 gets NO agents tool. A visited-set blocks A→B→A loops.
// MAX_COMMS_DEPTH lives in comms.ts so tests can pin it without the server.
const agentsProxyPath = (() => {
  const ts = join(dirname(fileURLToPath(import.meta.url)), "drivers", "agents-proxy.ts");
  return existsSync(ts) ? ts : ts.replace(/\.ts$/, ".js");
})();
const composioProxyPath = (() => {
  const ts = join(dirname(fileURLToPath(import.meta.url)), "composio-proxy.ts");
  return existsSync(ts) ? ts : ts.replace(/\.ts$/, ".js");
})();
// in the packaged app process.execPath is Electron — run the proxy as node
const AGENTS_NODE_FLAG = { ELECTRON_RUN_AS_NODE: "1" };

function agentsIntegration(botId: string, depth: number, visited: string[] = [], groupThreadId?: string) {
  return {
    command: process.execPath,
    args: [agentsProxyPath],
    env: {
      ...AGENTS_NODE_FLAG,
      OMB_HARNESS_URL: `http://127.0.0.1:${PORT}`,
      OMB_BOT_ID: botId,
      OMB_COMMS_TOKEN: COMMS_TOKEN,
      OMB_TURN_DEPTH: String(depth),
      OMB_VISITED: visited.join(","),
      ...(groupThreadId ? { OMB_GROUP_THREAD_ID: groupThreadId } : {}),
    },
  };
}

function composioIntegration(allowedApps: string[]) {
  return {
    command: process.execPath,
    args: [composioProxyPath],
    env: {
      ...AGENTS_NODE_FLAG,
      OMB_COMPOSIO_URL: cfg.composio?.url || "",
      OMB_COMPOSIO_KEY: cfg.composio!.key!,
      OMB_ALLOWED_TOOLKITS: allowedApps.join(","),
    },
  };
}

/** Run a turn on `targetBotId` and resolve with its assistant text — the
 * synchronous half of ask_bot. Subscribes to the bus, folds assistant_text
 * for that thread, resolves on turn.completed (or a 4-min ceiling). */
function askBotAndWait(
  targetBotId: string,
  message: string,
  depth: number,
  opts?: { visited?: string[]; groupThreadId?: string },
): Promise<string> {
  const target = store.bot(targetBotId);
  if (!target) return Promise.resolve("(no such bot)");
  const threadId = target.threadId;
  const groupThreadId = opts?.groupThreadId;
  return new Promise((resolve) => {
    let text = "";
    let done = false;
    const finish = (out: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsub();
      if (groupThreadId && out && !out.startsWith("(couldn't start") && !out.startsWith("(timed out") && !out.startsWith("(no such")) {
        const note = store.appendMessage(groupThreadId, {
          role: "bot",
          kind: "text",
          text: `@${target.name}: ${out}`,
        });
        broadcast({ kind: "message", threadId: groupThreadId, message: note });
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
    startTurn(targetBotId, message, {
      commsDepth: depth + 1,
      visited: uniqueIds([...(opts?.visited ?? []), targetBotId]),
      groupThreadId,
    }).catch((err) =>
      finish(`(couldn't start that bot: ${err instanceof Error ? err.message : String(err)})`),
    );
  });
}

// default selection for new bots: first available instance, codex preferred over claude
async function defaultSelection() {
  const described = await registry.describe();
  const available = described.filter((d) => d.snapshot.state === "available");
  const pick = available.find((d) => d.driverKind === "codex") ?? available.find((d) => d.driverKind === "claudeAgent") ?? available[0] ?? described[0];
  return { instanceId: pick?.instanceId ?? "claude", model: pick?.models.default || "claude-sonnet-5" };
}

async function selectionForModel(model?: string) {
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

function publicBot(id: string) {
  const bot = store.bot(id);
  if (!bot) return null;
  return { ...bot, messages: store.messagesFor(bot.threadId) };
}

/** Create a sidebar bot and fan it out on SSE so the UI list updates even
 * when the creator is an agents-proxy call rather than the composer +. */
async function createSidebarBot(init?: { name?: string; title?: string; description?: string; model?: string }) {
  const bot = store.createBot();
  store.patchBot(bot.id, {
    modelSelection: await selectionForModel(init?.model),
    ...(init?.name?.trim() ? { name: init.name.trim() } : {}),
    ...(typeof init?.title === "string" ? { title: init.title } : {}),
    ...(typeof init?.description === "string" ? { description: init.description } : {}),
  });
  const full = publicBot(bot.id)!;
  broadcast({ kind: "bot.added", bot: full });
  return full;
}
let bootSelection = { instanceId: "claude", model: "claude-sonnet-5" };
const store = new Store(() => bootSelection);
bootSelection = await defaultSelection();
store.seedIfEmpty();
const routineByThread = new Map<string, string>();
const pendingAskByRequest = new Map<string, { botId: string; tool: string; summary: string; requestType: string }>();

const idleListeners = new Set<(botId: string) => void>();
function notifyIdle(botId: string) {
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

type TeachSession = { botId: string; events: TeachEvent[]; frames: TeachFrame[]; unsub: () => void };
const teachSessions = new Map<string, TeachSession>();
function startTeachSession(botId: string) {
  const bot = store.bot(botId);
  if (!bot) throw Object.assign(new Error("no such bot"), { status: 404 });
  teachSessions.get(botId)?.unsub();
  const events: TeachEvent[] = [];
  const frames: TeachFrame[] = [];
  const unsub = bus.subscribe((event: RuntimeEvent) => {
    if (event.threadId !== bot.threadId) return;
    const itemType = "itemType" in event ? event.itemType : undefined;
    const title = "title" in event ? event.title : undefined;
    const text = "text" in event ? event.text : undefined;
    const tool = "tool" in event ? event.tool : undefined;
    events.push({
      type: event.type,
      ...(typeof itemType === "string" ? { itemType } : {}),
      ...(typeof title === "string" ? { title } : {}),
      ...(typeof text === "string" ? { text } : {}),
      ...(typeof tool === "string" ? { tool } : {}),
      createdAt: event.createdAt,
    });
  });
  teachSessions.set(botId, { botId, events, frames, unsub });
  return { ok: true, recording: true };
}
async function stopTeachSession(botId: string, name?: string) {
  const session = teachSessions.get(botId);
  if (!session) throw Object.assign(new Error("no teach session in progress"), { status: 404 });
  session.unsub();
  teachSessions.delete(botId);
  const instance = registry.get(store.bot(botId)?.modelSelection.instanceId ?? "");
  const markdown = await distillSkill({
    name: name?.trim() || "Taught skill",
    events: session.events,
    frames: session.frames,
    generateText: instance?.generateText?.bind(instance),
  });
  const skill = saveSkill({ name: name?.trim() || "Taught skill", botId, markdown });
  return { skill };
}

const proactive = createProactive({
  now: () => Date.now(),
  onNudge: (botId) => {
    const bot = store.bot(botId);
    if (!bot) return;
    store.patchBot(botId, { unread: true });
    broadcast({ kind: "bot", bot: store.bot(botId) });
    broadcast({ kind: "nudge", botId, reason: "stall" });
  },
  onTrigger: (botId, prompt) => {
    startTurn(botId, prompt).catch(() => {});
  },
});

async function runRoutine(id: string) {
  const routine = store.routine(id);
  if (!routine || !routine.enabled || routine.running) return;
  const bot = store.bot(routine.botId);
  if (!bot) {
    store.patchRoutine(id, { enabled: false });
    store.markRoutine(id, { running: false, lastRunAt: Date.now(), lastResult: "blocked: no such bot" });
    return;
  }
  if (bot.busy) {
    store.markRoutine(id, { lastRunAt: Date.now(), lastResult: "skipped: bot busy", nextRunAt: nextRunAt(routine.schedule) });
    return;
  }
  store.markRoutine(id, { running: true, lastRunAt: Date.now(), lastResult: "running", nextRunAt: nextRunAt(routine.schedule) });
  routineByThread.set(bot.threadId, id);
  try {
    const skill = routine.skillId ? getSkill(routine.skillId) : null;
    await startTurn(routine.botId, skillPrompt(skill, routine.prompt));
  } catch (e) {
    routineByThread.delete(bot.threadId);
    store.markRoutine(id, { running: false, lastResult: `blocked: ${e instanceof Error ? e.message : String(e)}` });
  }
}
function schedulerTick(now = Date.now()) {
  for (const routine of store.routines) {
    if (routine.enabled && !routine.running && routine.nextRunAt <= now) void runRoutine(routine.id);
  }
  proactive.tick(now);
}
setTimeout(schedulerTick, 25).unref?.();
setInterval(schedulerTick, 15_000).unref?.();

// ── SSE fan-out to clients ─────────────────────────────────────────────
const sseClients = new Set<ServerResponse>();
function broadcast(payload: unknown) {
  const frame = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of [...sseClients]) {
    try {
      res.write(frame);
    } catch {
      sseClients.delete(res);
    }
  }
}

// ── server-side event folding (upstream's ingestion worker, miniature) ──
// The canonical stream is the source of truth; the persisted transcript
// and every client view are projections of it.
const toolMessageByItem = new Map<string, string>(); // itemId -> messageId
const askMessageByRequest = new Map<string, string>(); // requestId -> messageId
const turnUsage = new Map<string, Usage>();
const responseOptionsByTurn = new Map<string, string[]>();

bus.subscribe((event: RuntimeEvent) => {
  broadcast({ kind: "runtime", event });
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
        store.setResumeCursor(bot.id, event.providerInstanceId, event.sessionId);
      }
      break;
    case "turn.started":
      if (event.turnId) turnUsage.delete(event.turnId);
      store.patchBot(bot.id, { busy: true, state: "RUNNING", stateDetail: undefined });
      proactive.noteState(bot.id, "RUNNING");
      broadcast({ kind: "bot", bot: store.bot(bot.id) });
      break;
    case "thread.token-usage.updated":
      if (event.turnId) turnUsage.set(event.turnId, { input: event.input, output: event.output, cost: null });
      break;
    case "item.completed":
      if (event.itemType === "assistant_text") {
        const reply = parseResponseOptions(event.text);
        if (reply.text) pushMessage({ role: "bot", kind: "text", text: reply.text });
        if (event.turnId && shouldAttachResponseOptions(event.provider)) {
          responseOptionsByTurn.set(event.turnId, reply.options);
        }
      } else if (event.itemType === "tool" && event.itemId) {
        const messageId = toolMessageByItem.get(event.itemId);
        if (messageId) {
          const patched = store.patchMessage(event.threadId, messageId, {
            tool: { name: store.messagesFor(event.threadId).find((m) => m.id === messageId)?.tool?.name ?? "tool", ok: event.ok },
          });
          if (patched) broadcast({ kind: "message.patch", threadId: event.threadId, message: patched });
          toolMessageByItem.delete(event.itemId);
        }
        // the bot just finished acting — refresh its screen preview now
        pokeScreenPoller(bot.id);
      }
      break;
    case "item.started":
      if (event.itemType === "tool") {
        const message = pushMessage({ role: "bot", kind: "activity", tool: { name: event.title ?? "tool" } });
        if (event.itemId) toolMessageByItem.set(event.itemId, message.id);
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
      if (event.requestType === "permission" && event.requestId) {
        const auto = resolveOpenedRequest(bot.id, event.tool, event.summary);
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
      const credential = event.requestType === "credential";
      const message = pushMessage({
        role: "bot",
        kind: "options",
        card: {
          title: credential ? HANDOFF_TITLE : permission ? "Approval needed" : "Your bot has a question",
          subtitle: credential
            ? sanitizeHandoffSummary(event.summary) || HANDOFF_SUBTITLE
            : event.summary,
          options: event.choices?.length
            ? event.choices
            : credential
              ? [HANDOFF_CONTINUE]
              : permission
                ? ["Allow", "Deny"]
                : [],
          requestId: event.requestId,
          requestType: event.requestType,
        },
      });
      if (event.requestId) askMessageByRequest.set(event.requestId, message.id);
      store.patchBot(bot.id, { state: "NEEDS_INPUT" });
      proactive.noteState(bot.id, "NEEDS_INPUT");
      broadcast({ kind: "bot", bot: store.bot(bot.id) });
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
      store.patchBot(bot.id, { state: "RUNNING" });
      proactive.noteState(bot.id, "RUNNING");
      broadcast({ kind: "bot", bot: store.bot(bot.id) });
      break;
    }
    case "runtime.error":
      if (event.turnId) responseOptionsByTurn.delete(event.turnId);
      pushMessage({ role: "bot", kind: "activity", tool: { name: `error: ${event.message.slice(0, 160)}`, ok: false } });
      store.patchBot(bot.id, { busy: false, state: "BLOCKED", stateDetail: event.message.slice(0, 160) });
      proactive.noteState(bot.id, "BLOCKED");
      notifyIdle(bot.id);
      broadcast({ kind: "bot", bot: store.bot(bot.id) });
      break;
    case "turn.completed": {
      // the last live frame becomes a settled inline screen message —
      // the screenshot-in-chat moment
      const frame = stopScreenPoller(bot.id);
      if (frame) pushMessage({ role: "bot", kind: "screen", png: frame.png, mime: frame.mime });
      const tokens = (event.turnId ? turnUsage.get(event.turnId) : undefined) ?? { input: 0, output: 0, cost: null };
      store.recordTurnUsage(bot.id, { ...tokens, cost: event.cost ?? null });
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
      store.patchBot(bot.id, { busy: false, unread: true, state: event.ok ? "DONE" : "BLOCKED", stateDetail: event.stopReason ?? undefined });
      proactive.noteState(bot.id, event.ok ? "DONE" : "BLOCKED");
      notifyIdle(bot.id);
      const routineId = routineByThread.get(event.threadId);
      if (routineId) {
        const routine = store.routine(routineId);
        store.markRoutine(routineId, { running: false, lastResult: event.ok ? "DONE" : `BLOCKED: ${event.stopReason ?? "failed"}` });
        routineByThread.delete(event.threadId);
        if (routine?.thenStartTurn) proactive.routineCompleted(routine.thenStartTurn);
      }
      if (event.ok) {
        const instance = registry.get(bot.modelSelection.instanceId);
        void distillMemory({
          botId: bot.id,
          turnText: turnTextFromMessages(store.messagesFor(event.threadId)),
          generateText: instance?.generateText?.bind(instance),
        });
      }
      broadcast({ kind: "bot", bot: store.bot(bot.id) });
      break;
    }
  }
});

// ── live screen: poll the bot's box while it works ────────────────────
// Frames stream to clients as SSE {kind:'screen'} (the "Bot's screen"
// panel); the final frame is folded into the transcript on turn end.
type Frame = { png: string; mime: string };
const screenPollers = new Map<
  string,
  { timer: ReturnType<typeof setInterval>; capture: () => Promise<void>; last: Frame | null }
>();

function startScreenPoller(botId: string) {
  if (screenPollers.has(botId) || !box.boxConfigured(cfg)) return;
  let inFlight = false;
  const capture = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      const { png, format } = await box.screenshotBox(cfg, botId);
      const frame = { png, mime: format === "jpeg" ? "image/jpeg" : "image/png" };
      entry.last = frame;
      teachSessions.get(botId)?.frames.push({ at: Date.now() });
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

// Local computer-use contract written by Electron main on startup
// (app.getPath("userData")/cua-connection.json). Electron passes the exact
// location because that path is OS-specific. Read fresh each turn.
function cuaConnectionCandidates(): string[] {
  if (process.env.OMB_USER_DATA) return [join(process.env.OMB_USER_DATA, "cua-connection.json")];
  const root =
    process.platform === "win32"
      ? (process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"))
      : process.platform === "darwin"
        ? join(homedir(), "Library", "Application Support")
        : (process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"));
  return ["VelarixBot", "velarixbot", "OpenMausBot", "openmausbot", "OpenGrokBot", "opengrokbot"].map(
    (dir) => join(root, dir, "cua-connection.json"),
  );
}

function readCuaConnection(): { command: string; args: string[]; env: Record<string, string> } | null {
  for (const p of cuaConnectionCandidates()) {
    try {
      const conn = JSON.parse(readFileSync(p, "utf8"));
      if (!conn || conn.mode === "unavailable" || !conn.mcpCommand) continue;
      return { command: conn.mcpCommand, args: conn.mcpArgs ?? ["mcp"], env: conn.mcpEnv ?? {} };
    } catch {
      /* try the next location */
    }
  }
  return null;
}

// ── turn dispatch (upstream ProviderCommandReactor, miniature) ──────────
async function startTurn(
  botId: string,
  text: string,
  opts?: {
    commsDepth?: number;
    attachments?: Array<{ path: string; mime?: string }>;
    visited?: string[];
    groupThreadId?: string;
  },
) {
  const bot = store.bot(botId);
  if (!bot) throw Object.assign(new Error("no such bot"), { status: 404 });
  if (bot.busy) throw Object.assign(new Error("the bot is already working — interrupt it first"), { status: 409 });
  proactive.reset(botId);
  const commsDepth = opts?.commsDepth ?? 0;
  const visited = uniqueIds([...(opts?.visited ?? []), bot.id]);
  const groupThreadId = opts?.groupThreadId ?? (commsDepth === 0 ? bot.threadId : undefined);

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
  if (bot.computer === "local" && fullAuto) {
    store.patchBot(bot.id, { state: "BLOCKED", stateDetail: "local computer cannot be combined with provider full-auto" });
    proactive.noteState(bot.id, "BLOCKED");
    throw Object.assign(new Error("unsafe configuration: local computer cannot be combined with provider full-auto"), { status: 409 });
  }

  const userMessage = store.appendMessage(bot.threadId, { role: "user", kind: "text", text });
  broadcast({ kind: "message", threadId: bot.threadId, message: userMessage });

  // transcript for API-backed drivers: settled text turns only
  const transcript = store
    .messagesFor(bot.threadId)
    .filter((m) => m.kind === "text" && m.text && m.id !== userMessage.id)
    .slice(-40)
    .map((m) => ({ role: m.role === "user" ? ("user" as const) : ("assistant" as const), text: m.text! }));

  const persona = [
    `You are ${bot.name}, a personal bot in VelarixBot.`,
    bot.title && `Role: ${bot.title}.`,
    bot.description && `About: ${bot.description}`,
    "Stay in that character. Coordinate in this VelarixBot workspace; do not implement the user's repo or run a coding audit unless they explicitly ask for code. Do not dump a feature tour or A/B/C onboarding.",
  ]
    .filter(Boolean)
    .join(" ");

  // busy flips immediately so the composer locks; the dispatch itself runs
  // in the background — box provisioning can take ~90s and must never
  // hang the HTTP request
  store.patchBot(bot.id, { busy: true, unread: false, state: "RUNNING", stateDetail: undefined });
  proactive.noteState(bot.id, "RUNNING");
  broadcast({ kind: "bot", bot: store.bot(bot.id) });

  void (async () => {
    try {
      const integrations: NonNullable<Parameters<typeof instance.adapter.sendTurn>[0]["integrations"]> = {};
      if (cfg.composio?.key && bot.enabledApps?.length) {
        integrations.composio = composioIntegration(bot.enabledApps);
      }
      const wants = bot.computer;
      if (wants === "cloud" && box.boxConfigured(cfg)) {
        let b = await box.findBox(cfg, bot.id).catch(() => null);
        // the Computer driver runs ON the box — provision it on first use
        if (!b && instance.driverKind === "boxAgent") {
          broadcast({ kind: "computer", botId: bot.id, state: "provisioning" });
          await box.provisionBox(cfg, bot.id, bot.name);
          b = await box.findBox(cfg, bot.id).catch(() => null);
        }
        if (b) integrations.computer = { boxId: b.id, token: cfg.box!.token! };
      }
      // local computer (this Mac) via the Electron-hosted cua-driver: the
      // Electron main process owns the daemon (TCC attribution) and writes
      // its spawn contract to cua-connection.json; the harness only reads it
      if (wants === "local") {
        const cua = readCuaConnection();
        if (cua) integrations.localComputer = cua;
      }
      // peer-agent comms: give a user-initiated turn list_bots / ask_bot /
      // create_bot. Always mount at depth 0 so a lone bot can still create
      // sidebar peers. A comms-invoked turn (depth ≥ cap) gets none — hard
      // recursion stop. Only drivers that mount the tools get the integration
      // (and the prompt hint). Any bot can still be the TARGET of ask_bot.
      if (commsDepth < MAX_COMMS_DEPTH && instance.adapter.capabilities.agentsMcp === true) {
        integrations.agents = agentsIntegration(bot.id, commsDepth, visited, groupThreadId);
      }
      // @mentions in the user's message (the composer's tagging UI) become
      // an explicit delegation nudge — the agent still does the ask_bot call
      // itself, so the harness stays the single owner of turns/permissions
      const tagged = integrations.agents
        ? mentionedBots(
            text,
            store.bots.filter((b) => b.id !== bot.id),
          )
        : [];
      if (tagged.length) {
        store.patchBot(bot.id, {
          threadParticipants: uniqueIds([bot.id, ...(bot.threadParticipants ?? []), ...tagged.map((t) => t.id)]),
        });
      }

      await instance.adapter.sendTurn({
        threadId: bot.threadId,
        text,
        model: bot.modelSelection.model,
        resumeCursor: bot.resumeCursors[bot.modelSelection.instanceId],
        transcript,
        attachments: opts?.attachments,
        system:
          persona +
          memoryPrompt(bot.id) +
          (shouldAttachResponseOptions(instance.driverKind) ? responseOptionsPrompt : "") +
          (integrations.computer && instance.driverKind !== "boxAgent"
            ? " You have your own cloud computer — use the computer tools (screenshot, computer_exec, open_url) whenever browsing or acting on a desktop helps."
            : integrations.localComputer
              ? " You can act on the user's computer through the computer tools — take a screenshot or read the desktop state first, prefer accessibility actions over raw coordinates, and act carefully."
              : "") +
          (integrations.agents
            ? " You can work with the user's VelarixBot sidebar bots through the agents tools. list_bots shows who exists. ask_bot messages one and returns its reply — the reply stays in this transcript, do not ask the user to relay it. create_bot creates a real sidebar bot (name, title, description, optional model) — use it when asked to create bots. Never invent Codex or conversation-only sub-agents; they will not appear in the sidebar. Never create bots with the shell, PowerShell, or by writing scripts — only create_bot."
            : "") +
          (tagged.length
            ? ` The user tagged ${tagged
                .map((t) => `@${t.name} (ask_bot bot_id ${t.id})`)
                .join(" and ")} in their message — bring them into this group thread with ask_bot. Their replies belong in this transcript; do not route handoffs through the user.`
            : ""),
        integrations,
        requireApproval: bot.requireApproval === true,
      });
      if (integrations.computer) startScreenPoller(bot.id);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const failure = store.appendMessage(bot.threadId, {
        role: "bot",
        kind: "activity",
        tool: { name: `error: ${message.slice(0, 160)}`, ok: false },
      });
      broadcast({ kind: "message", threadId: bot.threadId, message: failure });
      store.patchBot(bot.id, { busy: false, state: "BLOCKED", stateDetail: message.slice(0, 160) });
      proactive.noteState(bot.id, "BLOCKED");
      notifyIdle(bot.id);
      broadcast({ kind: "bot", bot: store.bot(bot.id) });
    }
  })();
}

// ── config hot-reload ─────────────────────────────────────────────────
function configStatus() {
  return {
    xai: { configured: Boolean(cfg.xai?.key) },
    composio: { configured: Boolean(cfg.composio?.key), apiKeyConfigured: Boolean(cfg.composio?.apiKey) },
    box: { configured: Boolean(cfg.box?.token) },
    github: { configured: Boolean(cfg.github?.token) },
  };
}

/** Rebuild the provider fleet after a config change so new keys take
 * effect without a server restart (kills any in-flight turns). */
async function reloadProviders() {
  bus.detachAll();
  await registry.disposeAll();
  await registry.load(instanceConfigs(cfg));
  bus.attach(registry.instances());
}

// ── HTTP plumbing ─────────────────────────────────────────────────────
function json(res: ServerResponse, status: number, body: unknown) {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(data);
}

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 1_000_000) reject(new Error("body too large"));
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const path = url.pathname;
  const method = req.method ?? "GET";
  try {
    // ── internal peer-agent comms (localhost + shared token only) ──────
    // The agents-proxy (spawned inside a bot's agent process) calls these to
    // discover peers and hand a message to one. Not part of the public API.
    if (path.startsWith("/api/internal/")) {
      if (req.headers.authorization !== `Bearer ${COMMS_TOKEN}`) {
        return json(res, 401, { error: "unauthorized" });
      }
      if (method === "GET" && path === "/api/internal/agents") {
        const self = url.searchParams.get("self");
        const bots = store.bots
          .filter((b) => b.id !== self && !b.hidden)
          .map((b) => ({ id: b.id, name: b.name, model: b.modelSelection.model, busy: !!b.busy }));
        return json(res, 200, { bots });
      }
      if (method === "POST" && path === "/api/internal/ask-bot") {
        const body = await readBody(req);
        const fromBotId = String(body.fromBotId ?? "");
        const toBotId = String(body.toBotId ?? "");
        const message = String(body.message ?? "").trim();
        const depth = Number(body.depth ?? 0) || 0;
        const visited = parseVisited(body.visited ?? body.visitedIds);
        if (!toBotId || !message) return json(res, 400, { error: "toBotId and message required" });
        const guard = commsGuard(fromBotId, toBotId, depth, visited);
        if (!guard.ok) return json(res, 200, { error: guard.error });
        const target = store.bot(toBotId);
        if (!target) return json(res, 404, { error: "no such bot" });
        const from = store.bot(fromBotId);
        const fromName = from?.name ?? "another bot";
        const groupThreadId =
          (typeof body.groupThreadId === "string" && body.groupThreadId.trim()) || from?.threadId || undefined;
        if (from && groupThreadId) {
          store.patchBot(from.id, {
            threadParticipants: uniqueIds([from.id, ...(from.threadParticipants ?? []), toBotId]),
          });
          const note = store.appendMessage(groupThreadId, {
            role: "bot",
            kind: "activity",
            tool: { name: `asked @${target.name}: ${message.slice(0, 80)}` },
          });
          broadcast({ kind: "message", threadId: groupThreadId, message: note });
          broadcast({ kind: "bot", bot: store.bot(from.id) });
        }
        const prefixed = `[Message from @${fromName}, another bot in this VelarixBot workspace. Reply to them.]\n\n${message}`;
        const reply = await peerQueue.enqueue(toBotId, () =>
          askBotAndWait(toBotId, prefixed, depth, { visited: guard.chain, groupThreadId }),
        );
        return json(res, 200, { botName: target.name, text: reply });
      }
      if (method === "POST" && path === "/api/internal/create-bot") {
        const body = await readBody(req);
        const fromBotId = String(body.fromBotId ?? "");
        const name = String(body.name ?? "").trim();
        const title = String(body.title ?? "").trim();
        const description = String(body.description ?? "").trim();
        const model = String(body.model ?? "").trim();
        const depth = Number(body.depth ?? 0) || 0;
        if (!name || !title || !description) return json(res, 400, { error: "name, title, and description required" });
        if (depth >= MAX_COMMS_DEPTH) return json(res, 200, { error: COMMS_DEPTH_ERROR });
        const created = await createSidebarBot({ name, title, description, ...(model ? { model } : {}) });
        const from = store.bot(fromBotId);
        if (from) {
          const note = store.appendMessage(from.threadId, {
            role: "bot",
            kind: "activity",
            tool: { name: `created @${created.name}` },
          });
          broadcast({ kind: "message", threadId: from.threadId, message: note });
        }
        return json(res, 200, {
          bot: { id: created.id, name: created.name, title: created.title, description: created.description, model: created.modelSelection.model },
        });
      }
      return json(res, 404, { error: "unknown internal endpoint" });
    }

    // ── events stream ──
    if (method === "GET" && path === "/api/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(`data: ${JSON.stringify({ kind: "hello" })}\n\n`);
      sseClients.add(res);
      const keepalive = setInterval(() => {
        try {
          res.write(": keepalive\n\n");
        } catch {}
      }, 25_000);
      req.on("close", () => {
        clearInterval(keepalive);
        sseClients.delete(res);
      });
      return;
    }

    // ── persistent routines ──
    if (method === "GET" && path === "/api/routines") return json(res, 200, { routines: store.routines });
    if (method === "POST" && path === "/api/routines") {
      const body = await readBody(req);
      return json(res, 201, { routine: store.createRoutine({ botId: String(body.botId ?? ""), name: String(body.name ?? ""), prompt: String(body.prompt ?? ""), schedule: body.schedule, thenStartTurn: body.thenStartTurn, skillId: body.skillId }) });
    }
    let routineMatch = path.match(/^\/api\/routines\/([\w-]+)$/);
    if (routineMatch && method === "PATCH") {
      const body = await readBody(req);
      const routine = store.patchRoutine(routineMatch[1], { name: body.name, prompt: body.prompt, schedule: body.schedule, enabled: body.enabled, thenStartTurn: body.thenStartTurn, skillId: body.skillId });
      return routine ? json(res, 200, { routine }) : json(res, 404, { error: "no such routine" });
    }
    if (routineMatch && method === "DELETE") return store.deleteRoutine(routineMatch[1]) ? json(res, 200, { ok: true }) : json(res, 404, { error: "no such routine" });
    routineMatch = path.match(/^\/api\/routines\/([\w-]+)\/run$/);
    if (routineMatch && method === "POST") { await runRoutine(routineMatch[1]); return json(res, 202, { ok: true }); }

    // ── taught skills ──
    if (method === "GET" && path === "/api/skills") return json(res, 200, { skills: loadSkills() });
    if (method === "POST" && path === "/api/skills") {
      const body = await readBody(req);
      const skill = saveSkill({
        name: String(body.name ?? ""),
        botId: String(body.botId ?? ""),
        markdown: String(body.markdown ?? ""),
        id: typeof body.id === "string" ? body.id : undefined,
      });
      return json(res, 201, { skill });
    }
    let skillMatch = path.match(/^\/api\/skills\/([\w-]+)$/);
    if (skillMatch && method === "GET") {
      const skill = getSkill(skillMatch[1]);
      return skill ? json(res, 200, { skill }) : json(res, 404, { error: "no such skill" });
    }
    if (skillMatch && method === "PATCH") {
      const existing = getSkill(skillMatch[1]);
      if (!existing) return json(res, 404, { error: "no such skill" });
      const body = await readBody(req);
      const skill = saveSkill({
        id: existing.id,
        name: String(body.name ?? existing.name),
        botId: String(body.botId ?? existing.botId),
        markdown: String(body.markdown ?? existing.markdown),
      });
      return json(res, 200, { skill });
    }
    if (skillMatch && method === "DELETE") return deleteSkill(skillMatch[1]) ? json(res, 200, { ok: true }) : json(res, 404, { error: "no such skill" });

    let teachMatch = path.match(/^\/api\/bots\/([\w-]+)\/teach\/(start|stop)$/);
    if (teachMatch && method === "POST") {
      if (teachMatch[2] === "start") return json(res, 200, startTeachSession(teachMatch[1]));
      const body = await readBody(req).catch(() => ({}));
      return json(res, 200, await stopTeachSession(teachMatch[1], typeof body.name === "string" ? body.name : undefined));
    }

    // ── bots ──
    if (method === "GET" && path === "/api/bots") {
      return json(res, 200, {
        bots: store.bots.map((b) => ({ ...b, messages: store.messagesFor(b.threadId) })),
      });
    }
    if (method === "POST" && path === "/api/bots") {
      const bot = await createSidebarBot();
      return json(res, 201, { bot });
    }
    let m = path.match(/^\/api\/bots\/([\w-]+)$/);
    if (m && method === "PATCH") {
      const body = await readBody(req);
      const patch: Record<string, unknown> = {};
      for (const key of ["name", "title", "description", "notifications", "modelSelection", "unread", "computer", "color", "mascotExpression", "pinned", "hidden", "requireApproval", "enabledApps", "threadParticipants"] as const) {
        if (body[key] !== undefined) patch[key] = body[key];
      }
      if (patch.enabledApps !== undefined) patch.enabledApps = parseAllowedToolkits(patch.enabledApps);
      if (patch.computer === "local" && process.env.OMB_LOCAL_CUA_SUPPORTED === "0") {
        return json(res, 409, { error: "local computer control is not available on Windows; choose Cloud box or Off" });
      }
      if (patch.computer === "local" || (patch.modelSelection && store.bot(m[1])?.computer === "local")) {
        const current = store.bot(m[1]);
        const selected = (patch.modelSelection ?? current?.modelSelection) as { instanceId?: string } | undefined;
        const configured = selected?.instanceId ? cfg.instances?.[selected.instanceId] : undefined;
        if (configured?.config && typeof configured.config === "object" && (configured.config as { fullAuto?: unknown }).fullAuto === true) return json(res, 409, { error: "unsafe configuration: local computer cannot be combined with provider full-auto" });
        const selectedInstance = selected?.instanceId ? registry.get(selected.instanceId) : undefined;
        if (selectedInstance && selectedInstance.adapter.capabilities.localComputerMcp !== true) return json(res, 409, { error: "selected provider does not support guarded local computer control" });
      }
      const bot = store.patchBot(m[1], patch);
      if (!bot) return json(res, 404, { error: "no such bot" });
      broadcast({ kind: "bot", bot });
      return json(res, 200, { bot });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)$/);
    if (m && method === "DELETE") {
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      // a running turn dies with its bot
      await registry.get(bot.modelSelection.instanceId)?.adapter.interruptTurn(bot.threadId).catch(() => {});
      stopScreenPoller(bot.id);
      teachSessions.get(bot.id)?.unsub();
      teachSessions.delete(bot.id);
      deleteBotMemory(bot.id);
      deleteSkillsForBot(bot.id);
      store.deleteBot(bot.id);
      for (const dir of [EVENTS_DIR, NATIVE_DIR]) {
        try {
          unlinkSync(join(dir, `${bot.threadId}.ndjson`));
        } catch {}
      }
      broadcast({ kind: "bot.deleted", botId: bot.id });
      return json(res, 200, { ok: true });
    }

    // onboarding/ask cards persist their answered/dismissed state
    m = path.match(/^\/api\/bots\/([\w-]+)\/cards\/([\w-]+)$/);
    if (m && method === "PATCH") {
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      const existing = store.messagesFor(bot.threadId).find((msg) => msg.id === m![2]);
      if (!existing?.card) return json(res, 404, { error: "no such card" });
      const body = await readBody(req);
      const patched = store.patchMessage(bot.threadId, m[2], {
        card: {
          ...existing.card,
          ...(body.answered !== undefined ? { answered: body.answered } : {}),
          ...(body.dismissed !== undefined ? { dismissed: body.dismissed } : {}),
        },
      });
      broadcast({ kind: "message.patch", threadId: bot.threadId, message: patched });
      return json(res, 200, { message: patched });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/messages$/);
    if (m && method === "POST") {
      const body = await readBody(req);
      const rawText = String(body.text ?? "").trim();
      const rawAttachments = Array.isArray(body.attachments) ? body.attachments : [];
      const mimeByPath = new Map<string, string | undefined>();
      for (const item of rawAttachments) {
        if (item && typeof item.path === "string" && item.path.trim()) {
          mimeByPath.set(item.path.trim(), typeof item.mime === "string" ? item.mime : undefined);
        }
      }
      const paths = expandAttachmentPaths([...mimeByPath.keys()]);
      const text = attachmentPathRefs(rawText, paths);
      if (!text) return json(res, 400, { error: "text required" });
      const attachments = paths.map((path) => ({ path, mime: mimeByPath.get(path) }));
      await startTurn(m[1], text, { attachments });
      return json(res, 202, { ok: true });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/respond$/);
    if (m && method === "POST") {
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      const instance = registry.get(bot.modelSelection.instanceId);
      if (!instance) return json(res, 409, { error: "provider unavailable" });
      const body = await readBody(req);
      const requestId = String(body.requestId);
      const pending = pendingAskByRequest.get(requestId);
      if (body.always === true && pending?.requestType === "permission") {
        alwaysAllow(bot.id, pending.tool, pending.summary);
      }
      await instance.adapter.respondToRequest(bot.threadId, requestId, {
        behavior: body.behavior,
        message: body.message,
        always: body.always === true,
        source: "user",
      });
      return json(res, 200, { ok: true });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/interrupt$/);
    if (m && method === "POST") {
      const bot = store.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      const instance = registry.get(bot.modelSelection.instanceId);
      await instance?.adapter.interruptTurn(bot.threadId);
      store.patchBot(bot.id, { busy: false, state: "BLOCKED", stateDetail: "interrupted" });
      proactive.noteState(bot.id, "BLOCKED");
      notifyIdle(bot.id);
      broadcast({ kind: "bot", bot: store.bot(bot.id) });
      return json(res, 200, { ok: true });
    }

    // identity handshake for the packaged app's port fallback: the forked
    // child proves it is OURS by echoing its pid (a stray dev server has
    // the same API shape but a different pid)
    if (method === "GET" && path === "/api/health") {
      return json(res, 200, { app: "velarixbot", pid: process.pid, static: Boolean(STATIC_DIR) });
    }

    // ── provider instances (model picker) ──
    if (method === "GET" && path === "/api/instances") {
      return json(res, 200, { instances: await registry.describe() });
    }

    // ── app config (API keys — never echoed back, booleans only) ──
    if (method === "GET" && path === "/api/config") {
      return json(res, 200, configStatus());
    }
    if ((method === "PUT" || method === "PATCH") && path === "/api/config") {
      const body = await readBody(req);
      const patch: Record<string, object> = {};
      for (const key of ["xai", "composio", "box", "github"] as const) {
        if (body[key] && typeof body[key] === "object") patch[key] = body[key];
      }
      if (!Object.keys(patch).length) return json(res, 400, { error: "nothing to save" });
      saveConfig(patch);
      Object.assign(cfg, loadConfig());
      await reloadProviders();
      const status = configStatus();
      broadcast({ kind: "config", ...status });
      return json(res, 200, status);
    }

    // ── connectors (Composio) ──
    if (method === "GET" && path === "/api/connectors/catalog") {
      const { cards, source } = await composio.listToolkits(cfg);
      return json(res, 200, { configured: Boolean(cfg.composio?.key), source, cards });
    }
    if (method === "GET" && path === "/api/connectors") {
      const services = (url.searchParams.get("services") ?? "").split(",").filter(Boolean);
      if (!cfg.composio?.key) return json(res, 200, { configured: false, services: {} });
      const status = await composio.connectionStatus(cfg, services.length ? services : composio.CURATED_SLUGS);
      return json(res, 200, { configured: true, services: status });
    }
    m = path.match(/^\/api\/connectors\/([\w-]+)\/authorize$/);
    if (m && method === "POST") return json(res, 200, await composio.authorizeService(cfg, m[1]));
    m = path.match(/^\/api\/connectors\/([\w-]+)$/);
    if (m && method === "DELETE") return json(res, 200, await composio.removeService(cfg, m[1]));

    // ── the bot's cloud computer (Box) ──
    m = path.match(/^\/api\/bots\/([\w-]+)\/computer$/);
    if (m && method === "GET") return json(res, 200, await box.boxStatus(cfg, m[1]));
    m = path.match(/^\/api\/bots\/([\w-]+)\/computer\/(provision|join|sleep|exec|screenshot)$/);
    if (m && method === "POST") {
      const botId = m[1];
      const bot = store.bot(botId);
      if (!bot) return json(res, 404, { error: "no such bot" });
      switch (m[2]) {
        case "provision":
          return json(res, 200, await box.provisionBox(cfg, botId, bot.name));
        case "join":
          return json(res, 200, await box.joinBox(cfg, botId));
        case "sleep":
          return json(res, 200, await box.sleepBox(cfg, botId));
        case "exec": {
          const body = await readBody(req);
          return json(res, 200, await box.execOnBox(cfg, botId, String(body.command ?? "")));
        }
        case "screenshot":
          return json(res, 200, await box.screenshotBox(cfg, botId));
      }
    }

    // packaged app: the server serves the built UI too (window → :8799 for
    // everything, no dev proxy to die). OMB_STATIC_DIR is set by Electron.
    if (method === "GET" && !path.startsWith("/api/") && STATIC_DIR) {
      const safe = path === "/" ? "/index.html" : path.replace(/\.\./g, "");
      const file = join(STATIC_DIR, safe);
      try {
        const data = readFileSync(file);
        res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
        return res.end(data);
      } catch {
        // SPA fallback
        try {
          const data = readFileSync(join(STATIC_DIR, "index.html"));
          res.writeHead(200, { "content-type": "text/html" });
          return res.end(data);
        } catch {
          /* fall through to 404 */
        }
      }
    }

    return json(res, 404, { error: `no route: ${method} ${path}` });
  } catch (e) {
    const status = (e as any)?.status ?? 500;
    return json(res, status, { error: e instanceof Error ? e.message : String(e) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`velarixbot server on http://127.0.0.1:${PORT}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void registry.disposeAll().finally(() => process.exit(0));
  });
}
