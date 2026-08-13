// Codex driver — upstream CodexDriver skeleton over agentcal's
// drivers/codex.js runtime: the official `codex` CLI headless over its
// app-server JSON-RPC protocol (newline-delimited JSON on stdio).
// Completion is a real `turn/completed` notification; approval requests
// arrive as in-process server→client JSON-RPC requests and surface as
// canonical request.opened events (answered via respondToRequest — no MCP
// proxy or unix socket needed, unlike claude).
//
// Method → reply shape (codex-cli ≥0.144.4, verified against 0.147.0):
//   mcpServer/elicitation/request → {action:"accept"|"decline"} (+ _meta.persist
//     when Always-allow). This is the default MCP-tool approval path
//     (feature tool_call_mcp_elicitation, stable + default-on).
//   item/permissions/requestApproval → {permissions, scope}
//   execCommandApproval / applyPatchApproval → {decision:"approved"|"denied"}
//   item/commandExecution/requestApproval / item/fileChange/requestApproval
//     → {decision:"accept"|"decline"|"acceptForSession"}
//   item/tool/requestUserInput → {answers} (older-CLI MCP fallback)
// Unknown methods get JSON-RPC -32601 — never the command-approval {decision}
// schema. A wrong schema on elicitation is coerced by the CLI into Decline
// ("user rejected MCP tool call") even when the user clicked Allow.
//
// All three allow-paths share one elicitation reply helper: carded Allow,
// stored Always-allow rules (respondToRequest source "rule"), and fullAuto.
// fullAuto's approvalPolicy "never" usually stops Codex from eliciting, but
// if a request still arrives the reply must still be {action}, not {decision}.
//
// resumeCursor is the codex thread id; a later turn tries thread/resume
// and falls back to a fresh thread/start. Persona is
// thread/start|resume.developerInstructions (not prepended onto user text).
// A child that exits 0 before turn/completed is a finished turn, not a kill.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  DriverCreateInput,
  ProviderDriver,
  ProviderInstance,
  ProviderSnapshot,
  RuntimeEvent,
  RuntimeEventListener,
  SendTurnInput,
} from "../contracts.ts";
import { newEventId, newId } from "../contracts.ts";
import { ensureBotWorkspace } from "../config.ts";
import { augmentedPath } from "../env-path.ts";
import { codexImageInput } from "../attachments.ts";
import { HANDOFF_CONTINUE, classifyOpenedRequest, isCredentialAsk } from "../handoff.ts";
import { cliVersion, killProcessTree, spawnCliHidden } from "./cli.ts";
import { FALLBACK_CODEX_MODELS, loadCodexModelCatalog } from "./codex-models.ts";
import { appendNative } from "./native.ts";

const DRIVER_KIND = "codex";

// proxy entry files live next to this one as .ts in dev (node type
// stripping) and .js in the compiled dist-server the packaged app ships
const proxyPath = (basename: string) => {
  const ts = join(dirname(fileURLToPath(import.meta.url)), "..", `${basename}.ts`);
  return existsSync(ts) ? ts : ts.replace(/\.ts$/, ".js");
};
const PROXY_PATH = proxyPath("computer-proxy");
// in the packaged app process.execPath is the Electron binary — this env
// makes it behave as plain node for the spawned MCP proxies (harmless in dev)
const NODE_ENV_FLAG = { ELECTRON_RUN_AS_NODE: "1" };

/** Per-turn MCP overlay for thread/start and thread/resume `config`. Empty
 * when the turn has no integrations — callers must not send a config key. */
function mcpServersFromIntegrations(integrations: SendTurnInput["integrations"]): Record<string, unknown> {
  const mcpServers: Record<string, unknown> = {};
  if (integrations?.composio) {
    mcpServers.composio = {
      command: integrations.composio.command,
      args: integrations.composio.args,
      env: { ...NODE_ENV_FLAG, ...integrations.composio.env },
    };
  }
  if (integrations?.computer) {
    mcpServers.computer = {
      command: process.execPath,
      args: [PROXY_PATH],
      env: {
        ...NODE_ENV_FLAG,
        OGB_BOX_ID: integrations.computer.boxId,
        OGB_BOX_TOKEN: integrations.computer.token,
      },
    };
  } else if (integrations?.localComputer) {
    mcpServers.computer = { ...integrations.localComputer };
  }
  if (integrations?.agents) {
    mcpServers.agents = { ...integrations.agents };
  }
  if (integrations?.memory) {
    mcpServers.memory = { ...integrations.memory };
  }
  return mcpServers;
}

export interface CodexConfig {
  cli: string;
  fullAuto: boolean;
}

function decodeConfig(raw: unknown): CodexConfig {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    cli: typeof o.cli === "string" ? o.cli : "codex",
    fullAuto: o.fullAuto === true,
  };
}

const QUESTION_TIMEOUT_NOTE = "No answer was given — use your best judgment.";
const DENY_TIMEOUT_NOTE =
  "VelarixBot: nobody answered this permission request in time. Skip this action and finish what you can without it.";
const CONVERSATIONAL_INPUT_NOTE =
  "Continue in the chat. Do not present A/B/C or multiple-choice options; the user will type their next message. If they asked to create a bot, call the create_bot tool — never the shell.";

const USER_INPUT_METHODS = new Set(["item/tool/requestUserInput", "tool/requestUserInput"]);
/** Server→client method for MCP elicitations, including MCP tool-call approvals. */
export const CODEX_ELICITATION_METHOD = "mcpServer/elicitation/request";
/** Feature flag that routes MCP tool approvals through CODEX_ELICITATION_METHOD. */
export const CODEX_MCP_ELICITATION_FEATURE = "tool_call_mcp_elicitation";
const ELICITATION_METHOD = CODEX_ELICITATION_METHOD;
const PERMISSIONS_METHOD = "item/permissions/requestApproval";
const COMMAND_METHODS = new Set(["execCommandApproval", "item/commandExecution/requestApproval"]);
const EDIT_METHODS = new Set(["applyPatchApproval", "item/fileChange/requestApproval"]);
const LEGACY_APPROVAL_METHODS = new Set(["execCommandApproval", "applyPatchApproval"]);
const APPROVAL_OPTION = /^(accept|allow|approve|deny|decline|cancel)(\b|[A-Z\s(-]|$)/i;
const TOOL_QUOTE = /tool\s+"([^"]+)"/i;

function collectUserInputLabels(params: unknown): string[] {
  const questions = Array.isArray((params as { questions?: unknown })?.questions)
    ? ((params as { questions: unknown[] }).questions)
    : [];
  return questions.flatMap((q) => {
    const options = Array.isArray((q as { options?: unknown })?.options)
      ? ((q as { options: unknown[] }).options)
      : [];
    return options
      .map((o) => String((o as { label?: unknown; value?: unknown })?.label ?? (o as { value?: unknown })?.value ?? "").trim())
      .filter(Boolean);
  });
}

/** Codex `requestUserInput` is a conversational multiple-choice tool. Only
 * treat it as a permission card when every option is an approval verb
 * (Accept/Decline/Cancel — MCP/app tool-call approvals). */
export function isCodexUserInputMethod(method: string): boolean {
  return USER_INPUT_METHODS.has(method);
}

export function isCodexPermissionUserInput(params: unknown): boolean {
  const labels = collectUserInputLabels(params);
  return labels.length > 0 && labels.every((label) => APPROVAL_OPTION.test(label));
}

export function isCodexElicitationMethod(method: string): boolean {
  return method === ELICITATION_METHOD;
}

export function isCodexPermissionsMethod(method: string): boolean {
  return method === PERMISSIONS_METHOD;
}

/** Card copy for an MCP elicitation: tool name from _meta / quoted message /
 * serverName, summary from the CLI's message. Never "shell". */
export function codexElicitationCard(params: unknown): { tool: string; summary: string } {
  const p = (params ?? {}) as Record<string, unknown>;
  const server = typeof p.serverName === "string" ? p.serverName.trim() : "";
  const meta = p._meta && typeof p._meta === "object" ? (p._meta as Record<string, unknown>) : {};
  const titled = typeof meta.tool_title === "string" ? meta.tool_title.trim() : "";
  const message = typeof p.message === "string" ? p.message.trim() : "";
  const quoted = message.match(TOOL_QUOTE)?.[1]?.trim() ?? "";
  const tool = titled || quoted || server || "mcp";
  const summary = (message || [server, tool].filter(Boolean).join(" ")).slice(0, 200) || tool;
  return { tool, summary };
}

type AskFinish = (behavior: string, message?: string, source?: string, always?: boolean) => void;

function elicitationReply(allow: boolean, always?: boolean): Record<string, unknown> {
  if (!allow) return { action: "decline" };
  return always === true ? { action: "accept", _meta: { persist: "always" } } : { action: "accept" };
}

function permissionsReply(params: unknown, allow: boolean, always?: boolean): Record<string, unknown> {
  if (!allow) return { permissions: {}, scope: "turn" };
  const requested = (params as { permissions?: unknown })?.permissions;
  const permissions = requested && typeof requested === "object" ? requested : {};
  return { permissions, scope: always === true ? "session" : "turn" };
}

function commandReply(method: string, allow: boolean, always?: boolean): Record<string, unknown> {
  if (LEGACY_APPROVAL_METHODS.has(method)) return { decision: allow ? "approved" : "denied" };
  if (allow && always === true) return { decision: "acceptForSession" };
  return { decision: allow ? "accept" : "decline" };
}

export const CodexDriver: ProviderDriver<CodexConfig> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "Codex", supportsMultipleInstances: true },
  models: FALLBACK_CODEX_MODELS,
  decodeConfig,
  defaultConfig: () => decodeConfig({}),

  async create(input: DriverCreateInput<CodexConfig>): Promise<ProviderInstance> {
    const { instanceId, config } = input;
    const probeEnv = { ...process.env, PATH: augmentedPath() };
    let models = await loadCodexModelCatalog(config.cli, probeEnv);
    const listeners = new Set<RuntimeEventListener>();
    interface Turn {
      stop: () => void;
      turnId: string;
      asks: Map<string, AskFinish>;
    }
    const active = new Map<string, Turn>();

    const emit = (event: RuntimeEvent) => {
      for (const l of [...listeners]) l(event);
    };
    const base = (threadId: string, turnId: string) => ({
      eventId: newEventId(),
      provider: DRIVER_KIND,
      threadId,
      turnId,
      createdAt: new Date().toISOString(),
    });

    const sendTurn = async (turn: SendTurnInput) => {
      const { threadId } = turn;
      if (active.has(threadId)) throw new Error("a turn is already running on this thread");
      const turnId = newId();

      const mcpServersConfig = mcpServersFromIntegrations(turn.integrations);
      const mcpOverlay = Object.keys(mcpServersConfig).length ? { mcp_servers: mcpServersConfig } : null;

      const workspace = turn.cwd ?? ensureBotWorkspace("codex");
      const env: Record<string, string | undefined> = { ...process.env, PATH: augmentedPath(), NPM_CONFIG_LOGLEVEL: "error" };
      // the CLI owns its own ChatGPT login; a leaked API key silently flips
      // billing to pay-as-you-go (agentcal)
      delete env.OPENAI_API_KEY;

      const child = spawnCliHidden(config.cli, ["app-server"], {
        cwd: workspace,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
      });

      const state = { settled: false, lastText: "", sawStreamDelta: false };
      const asks = new Map<string, AskFinish>();
      let nextId = 1;
      const rpcPending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

      const send = (obj: unknown) => {
        try {
          child.stdin.write(JSON.stringify(obj) + "\n");
        } catch {}
        appendNative(threadId, { dir: "out", source: "codex.app-server", msg: obj });
      };
      const request = (method: string, params: unknown) =>
        new Promise<any>((resolve, reject) => {
          const id = nextId++;
          rpcPending.set(id, { resolve, reject });
          send({ jsonrpc: "2.0", id, method, params });
        });

      const stop = () => killProcessTree(child.pid);

      const settle = (ok: boolean, stopReason: string | null) => {
        if (state.settled) return;
        state.settled = true;
        for (const finish of [...asks.values()]) finish("deny", "VelarixBot: the turn ended");
        for (const p of rpcPending.values()) p.reject(new Error("turn settled"));
        rpcPending.clear();
        active.delete(threadId);
        emit({ ...base(threadId, turnId), type: "turn.completed", ok, stopReason, cost: null });
        stop(); // the app-server never exits on its own
      };

      // server→client approval request → canonical request.opened.
      // Conversational requestUserInput (A/B/C "what next") is not a
      // permission ask — auto-answer it so it never becomes an OptionCard.
      // Each known method has its own reply schema; unknown methods must
      // not be answered with the command-approval {decision} payload.
      const handleServerRequest = (msg: any) => {
        const method = msg.method as string;
        const params = msg.params ?? {};
        const isUserInput = isCodexUserInputMethod(method);
        const isElicitation = isCodexElicitationMethod(method);
        const isPermissions = isCodexPermissionsMethod(method);
        const isCommand = COMMAND_METHODS.has(method);
        const isEdit = EDIT_METHODS.has(method);
        if (!isUserInput && !isElicitation && !isPermissions && !isCommand && !isEdit) {
          send({
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32601, message: `Method not found: ${method}` },
          });
          emit({
            ...base(threadId, turnId),
            type: "runtime.error",
            message: `codex requested unsupported method ${method}`,
          });
          return;
        }

        const elicitation = isElicitation ? codexElicitationCard(params) : null;
        const tool = isEdit
          ? "edit"
          : isUserInput
            ? "ask_user"
            : isElicitation
              ? elicitation!.tool
              : isPermissions
                ? "permissions"
                : "shell";
        const summaryPreview =
          typeof params.command === "string"
            ? params.command.slice(0, 200)
            : isElicitation
              ? elicitation!.summary
              : Array.isArray(params.questions)
                ? params.questions.map((q: any) => q.question ?? q.header).filter(Boolean).join(" · ")
                : typeof params.reason === "string"
                  ? params.reason
                  : tool;
        const credential = isCredentialAsk(isUserInput ? "question" : "permission", tool, summaryPreview);
        const permissionUserInput = isUserInput && isCodexPermissionUserInput(params);
        const conversational = isUserInput && !permissionUserInput && !credential;
        const answerUserInput = (message: string) => {
          const answers: Record<string, { answers: string[] }> = {};
          for (const q of Array.isArray(params.questions) ? params.questions : []) {
            if (q?.id) answers[q.id] = { answers: [message] };
          }
          send({ jsonrpc: "2.0", id: msg.id, result: { answers } });
        };
        const reply = (allow: boolean, always?: boolean) => {
          // Shared by carded Allow/Decline, Always-allow rule auto-resolve
          // (respondToRequest source "rule"), and fullAuto. Do not special-case
          // those callers onto the command-approval {decision} schema.
          const result = isElicitation
            ? elicitationReply(allow, always)
            : isPermissions
              ? permissionsReply(params, allow, always)
              : commandReply(method, allow, always);
          send({ jsonrpc: "2.0", id: msg.id, result });
        };

        if (conversational) {
          answerUserInput(CONVERSATIONAL_INPUT_NOTE);
          return;
        }

        if (config.fullAuto && !turn.requireApproval) {
          if (isUserInput) {
            const first = collectUserInputLabels(params).find((label) => APPROVAL_OPTION.test(label));
            answerUserInput(first || "Accept");
            return;
          }
          reply(true);
          return;
        }
        const requestId = newId();
        const summary = summaryPreview;
        const choices = isUserInput
          ? (params.questions?.[0]?.options ?? []).map((o: any) => o.label).filter(Boolean).slice(0, 5)
          : undefined;
        const opened = classifyOpenedRequest(
          credential ? "question" : permissionUserInput || !isUserInput ? "permission" : "question",
          tool,
          summary,
          choices,
        );
        const finish: AskFinish = (behavior, message, source = "user", always) => {
          if (!asks.delete(requestId)) return;
          clearTimeout(timer);
          if (isUserInput) {
            const fallback =
              behavior === "allow"
                ? opened.requestType === "credential"
                  ? HANDOFF_CONTINUE
                  : "Accept"
                : behavior === "deny"
                  ? "Decline"
                  : QUESTION_TIMEOUT_NOTE;
            answerUserInput(message || fallback);
          } else {
            reply(behavior === "allow", always === true);
          }
          emit({ ...base(threadId, turnId), type: "request.resolved", requestId, behavior, source });
        };
        const timer = setTimeout(
          () => (isUserInput ? finish("answer", QUESTION_TIMEOUT_NOTE) : finish("deny", DENY_TIMEOUT_NOTE)),
          15 * 60_000,
        );
        timer.unref?.();
        asks.set(requestId, finish);
        emit({
          ...base(threadId, turnId),
          type: "request.opened",
          requestId,
          requestType: opened.requestType,
          tool,
          summary: opened.summary,
          choices: opened.choices,
        });
      };

      const handleNotification = (msg: any) => {
        const p = msg.params ?? {};
        switch (msg.method) {
          // token-level chat text; the item/completed frame follows with the
          // whole message, so its delta is only a fallback when none streamed
          case "item/agentMessage/delta": {
            const delta = typeof p.delta === "string" ? p.delta : "";
            if (delta) {
              state.sawStreamDelta = true;
              emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "assistant_text", delta });
            }
            break;
          }
          case "item/reasoning/textDelta":
          case "item/reasoning/summaryTextDelta": {
            const delta = typeof p.delta === "string" ? p.delta : "";
            if (delta) emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "reasoning_text", delta });
            break;
          }
          case "item/started": {
            const item = p.item ?? {};
            const title =
              item.type === "commandExecution"
                ? String(item.command ?? "shell").slice(0, 80)
                : item.type === "fileChange"
                  ? "edit"
                  : item.type === "mcpToolCall"
                    ? (item.tool ?? item.name ?? "mcp")
                    : item.type === "webSearch"
                      ? "web_search"
                      : null;
            if (title) emit({ ...base(threadId, turnId), type: "item.started", itemType: "tool", itemId: item.id, title });
            break;
          }
          case "item/completed": {
            const item = p.item ?? {};
            if (item.type === "agentMessage") {
              if (item.text?.trim()) {
                state.lastText = item.text;
                if (!state.sawStreamDelta) {
                  emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "assistant_text", delta: item.text });
                }
                state.sawStreamDelta = false;
                emit({ ...base(threadId, turnId), type: "item.completed", itemType: "assistant_text", text: item.text });
              }
            } else if (["commandExecution", "fileChange", "mcpToolCall"].includes(item.type)) {
              emit({
                ...base(threadId, turnId),
                type: "item.completed",
                itemType: "tool",
                itemId: item.id,
                ok: item.status !== "failed" && item.status !== "declined",
              });
            } else if (item.type === "reasoning") {
              emit({ ...base(threadId, turnId), type: "item.updated", itemType: "reasoning", tokens: null });
            }
            break;
          }
          case "thread/tokenUsage/updated": {
            const t = p.tokenUsage?.last ?? p.tokenUsage?.total;
            if (t) {
              emit({
                ...base(threadId, turnId),
                type: "thread.token-usage.updated",
                input: t.inputTokens ?? 0,
                output: t.outputTokens ?? 0,
              });
            }
            break;
          }
          case "turn/completed": {
            const t = p.turn ?? {};
            settle(t.status === "completed", t.status === "completed" ? null : (t.error?.message ?? t.status ?? "failed"));
            break;
          }
          case "error":
            if (p.message) emit({ ...base(threadId, turnId), type: "runtime.error", message: p.message });
            break;
        }
      };

      const ingestLine = (line: string) => {
        if (!line.trim()) return;
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          return;
        }
        appendNative(threadId, { dir: "in", source: "codex.app-server", msg });
        if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
          const pend = rpcPending.get(msg.id);
          if (pend) {
            rpcPending.delete(msg.id);
            msg.error ? pend.reject(new Error(msg.error.message ?? JSON.stringify(msg.error))) : pend.resolve(msg.result);
          }
        } else if (msg.id !== undefined && msg.method) {
          handleServerRequest(msg);
        } else if (msg.method) {
          handleNotification(msg);
        }
      };

      let buf = "";
      const flushStdout = () => {
        let nl;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          ingestLine(line);
        }
      };
      child.stdout.on("data", (chunk) => {
        buf += chunk;
        flushStdout();
      });

      let stderr = "";
      child.stderr.on("data", (c) => {
        stderr += c;
        if (stderr.length > 8192) stderr = stderr.slice(-8192);
      });
      child.on("error", (e) => {
        emit({ ...base(threadId, turnId), type: "runtime.error", message: `spawn failed: ${e.message}` });
        settle(false, "spawn_error");
      });
      child.on("close", (code) => {
        flushStdout();
        if (state.settled) return;
        // Codex sometimes exits 0 without a turn/completed notification
        // (or the notification is still in the just-flushed buffer). That is
        // a clean end, not a killed turn — only a non-zero close is failure.
        if (code === 0) {
          settle(true, null);
          return;
        }
        emit({
          ...base(threadId, turnId),
          type: "runtime.error",
          message: `codex exited ${code} before turn/completed${stderr ? `: ${stderr.trim().slice(-300)}` : ""}`,
        });
        settle(false, "exit_before_result");
      });

      active.set(threadId, { stop, turnId, asks });
      emit({ ...base(threadId, turnId), type: "turn.started" });

      // handshake + kickoff; any refusal surfaces as failure, not a hang
      (async () => {
        try {
          await request("initialize", { clientInfo: { name: "velarixbot", version: "1" } });
          send({ jsonrpc: "2.0", method: "initialized", params: {} });
          const cursor = typeof turn.resumeCursor === "string" ? turn.resumeCursor : null;
          let codexThreadId: string | null = null;
          let startedModel: string | null = null;
          // each sendTurn spawns a fresh app-server, so resume must carry the
          // same mcp_servers overlay as start — otherwise extras vanish after
          // turn 1. thread/resume.config is a SessionFlags layer, same as start.
          // developerInstructions is the persona slot on both start and resume.
          if (cursor) {
            try {
              const resumeParams: Record<string, unknown> = { threadId: cursor };
              if (mcpOverlay) resumeParams.config = mcpOverlay;
              if (turn.system) resumeParams.developerInstructions = turn.system;
              const resumed = await request("thread/resume", resumeParams);
              codexThreadId = resumed?.thread?.id ?? cursor;
            } catch {
              /* resume unsupported or thread gone — start fresh below */
            }
          }
          if (!codexThreadId) {
            const threadStartParams: Record<string, unknown> = {
              cwd: workspace,
              model: turn.model || null,
              sandbox: config.fullAuto ? "danger-full-access" : "workspace-write",
              approvalPolicy: config.fullAuto ? "never" : "on-request",
              ephemeral: false,
            };
            if (mcpOverlay) threadStartParams.config = mcpOverlay;
            // thread/start accepts developerInstructions (camelCase, same as
            // approvalPolicy). That's the real system slot — do not prepend
            // persona onto the user turn text.
            if (turn.system) threadStartParams.developerInstructions = turn.system;
            const started = await request("thread/start", threadStartParams);
            codexThreadId = started?.thread?.id ?? null;
            startedModel = started?.model ?? null;
          }
          emit({ ...base(threadId, turnId), type: "session.started", sessionId: codexThreadId, model: startedModel ?? turn.model ?? null });
          await request("turn/start", {
            threadId: codexThreadId,
            input: [{ type: "text", text: turn.text }, ...codexImageInput(turn.attachments ?? [])],
          });
        } catch (e) {
          if (!state.settled) {
            emit({ ...base(threadId, turnId), type: "runtime.error", message: (e as Error).message });
            settle(false, "rpc_error");
          }
        }
      })();

      return { turnId };
    };

    const snapshot = async (): Promise<ProviderSnapshot> => {
      const version = await cliVersion(config.cli, 8000, probeEnv);
      if (!version) return { state: "unavailable", reason: `\`${config.cli}\` CLI not found` };
      models = await loadCodexModelCatalog(config.cli, probeEnv);
      return { state: "available", version };
    };

    return {
      instanceId,
      driverKind: DRIVER_KIND,
      displayName: input.displayName,
      enabled: input.enabled,
      get models() {
        return models;
      },
      snapshot,
      adapter: {
        provider: DRIVER_KIND,
        capabilities: {
          sessionModelSwitch: "unsupported",
          // true because sendTurn mounts agents/computer on both thread/start
          // and thread/resume (each turn is a fresh app-server)
          agentsMcp: true,
          localComputerMcp: true,
        },
        sendTurn,
        interruptTurn: async (threadId) => active.get(threadId)?.stop(),
        respondToRequest: async (threadId, requestId, decision) => {
          const turn = active.get(threadId);
          const finish = turn?.asks.get(requestId);
          if (!finish) throw new Error("no such pending request");
          finish(decision.behavior, decision.message, decision.source ?? "user", decision.always);
        },
        hasSession: (threadId) => active.has(threadId),
        stopAll: async () => {
          for (const { stop } of active.values()) stop();
        },
        onEvent: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      dispose: async () => {
        for (const { stop } of active.values()) stop();
        listeners.clear();
      },
    };
  },
};
