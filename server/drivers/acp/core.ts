// Generic ACP (Agent Client Protocol) driver core — one JSON-RPC-2.0-over-
// stdio session runtime that every ACP CLI harness (Grok Build, Gemini CLI,
// …) rides. Modeled on t3code's AcpSessionRuntime + per-agent AcpSupport
// split: the protocol mechanics live here, the per-harness quirks (spawn
// argv, auth method, model catalog, sign-in check) live in a small support
// object. Adding a harness = write server/drivers/acp/<name>.ts.
//
// ACP has no `turn/completed` notification: the `session/prompt` RPC *result*
// is the completion signal (it carries stopReason + usage). Permission
// requests arrive as server→client `session/request_permission` and surface
// as canonical request.opened events, answered fail-closed (nothing approved
// unless the agent explicitly offered an `allow`-kind option — option ORDER
// is never a security contract). session/load REPLAYS history as ordinary
// session/update notifications, so updates are double-gated: nothing emits
// before the prompt is sent, and `_meta.isReplay` updates are dropped.
import { homedir } from "node:os";

import type {
  DriverCreateInput,
  ProviderDriver,
  ProviderInstance,
  ProviderSnapshot,
  RuntimeEvent,
  RuntimeEventListener,
  SendTurnInput,
} from "../../contracts.ts";
import { newEventId, newId } from "../../contracts.ts";
import { augmentedPath } from "../../env-path.ts";
import { acpImageBlocks, agentAcceptsImagePrompts } from "../../attachments.ts";
import { classifyOpenedRequest } from "../../handoff.ts";
import { appendNative } from "../native.ts";
import { cliVersion, displayCliPath, killProcessTree, probeProtocol, spawnCliHidden } from "../cli.ts";

export interface AcpConfig {
  cli: string;
  fullAuto: boolean;
  /** Optional home for this instance's sessions. */
  workspace?: string;
}

/** Per-harness specifics — everything that differs between Grok, Gemini, … */
export interface AcpSupport {
  driverKind: string;
  displayName: string;
  models: { default: string; options: Array<{ id: string; label: string }> };
  /** Default CLI binary name if the instance config doesn't override it. */
  defaultCli: string;
  /** Native-protocol log label, e.g. "grok.acp". */
  nativeSource: string;
  /** Message shown when the CLI is present but not signed in. */
  loginNote: string;
  /** CLI argv AFTER the binary name to enter ACP stdio mode. */
  spawnArgs(config: AcpConfig, turn: SendTurnInput): string[];
  /** Mutate the child env in place (e.g. strip a key). Optional. */
  transformEnv?(env: Record<string, string | undefined>): void;
  /** Pick the ACP authenticate methodId from initialize's advertised
   * authMethods; return null to skip the authenticate step. */
  pickAuthMethod(authMethods: Array<{ id?: string }>): string | null;
  /** "fail": abort the turn if auth is missing/errors (subscription CLIs).
   *  "continue": proceed anyway (CLIs that work off an ambient login). */
  authFailure: "fail" | "continue";
  /** snapshot(): is the CLI signed in? (env already carries the merged config) */
  isAuthenticated(env: Record<string, string | undefined>): boolean;
  /** Compose the session/prompt text. Default prepends the persona. */
  buildPromptText?(turn: SendTurnInput): string;
  /** Optional cheap one-shot text call (titles, memory distill) — e.g. a
   * `cli exec -p …` subprocess. Receives the instance config and the
   * already-transformed child env. Omit when the CLI has no one-shot mode. */
  generateText?(
    config: AcpConfig,
    env: Record<string, string | undefined>,
    prompt: string,
  ): Promise<string>;
}

const INIT_TIMEOUT = 20_000;
const NEW_SESSION_TIMEOUT = 30_000;
const LOAD_SESSION_TIMEOUT = 120_000; // history replay on a long thread is slow

// ACP's designated auth_required JSON-RPC error code. An expired/revoked
// login can surface here on session/prompt — authenticate having succeeded
// earlier — so the code, not only our own loginNote, must map to a clean
// auth_required failure instead of a generic rpc_error.
const ACP_AUTH_REQUIRED_CODE = -32000;

function decodeAcpConfig(defaultCli: string) {
  return (raw: unknown): AcpConfig => {
    const o = (raw ?? {}) as Record<string, unknown>;
    return {
      cli: typeof o.cli === "string" ? o.cli : defaultCli,
      fullAuto: o.fullAuto === true,
      workspace: typeof o.workspace === "string" ? o.workspace : undefined,
    };
  };
}

export function createAcpDriver(support: AcpSupport): ProviderDriver<AcpConfig> {
  const DRIVER_KIND = support.driverKind;
  const SOURCE = support.nativeSource;
  const decodeConfig = decodeAcpConfig(support.defaultCli);
  const DENY_TIMEOUT_NOTE =
    "VelarixBot: nobody answered this permission request in time. Skip this action and finish what you can without it.";

  return {
    driverKind: DRIVER_KIND,
    metadata: { displayName: support.displayName, supportsMultipleInstances: true },
    models: support.models,
    decodeConfig,
    defaultConfig: () => decodeConfig({}),

    async create(input: DriverCreateInput<AcpConfig>): Promise<ProviderInstance> {
      const { instanceId, config } = input;
      const listeners = new Set<RuntimeEventListener>();
      interface Turn {
        stop: () => void;
        interrupt: () => void;
        turnId: string;
        asks: Map<string, (behavior: string, source?: string) => void>;
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

      const childEnv = () => {
        const env: Record<string, string | undefined> = {
          ...process.env,
          ...input.environment,
          PATH: augmentedPath(),
        };
        support.transformEnv?.(env);
        return env;
      };

      // ACP session mcpServers: stdio is the baseline every ACP agent
      // supports (mcpCapabilities.http/.sse only add EXTRA transports), so
      // an injected stdio proxy — e.g. the peer-agent comms tool — attaches
      // fine here. env is the ACP {name,value}[] shape.
      const acpMcpServers = (turn: SendTurnInput) => {
        const servers: Array<{ name: string; command: string; args: string[]; env: Array<{ name: string; value: string }> }> = [];
        const push = (name: string, spec?: { command: string; args: string[]; env: Record<string, string> }) => {
          if (!spec) return;
          servers.push({
            name,
            command: spec.command,
            args: spec.args,
            env: Object.entries(spec.env).map(([n, value]) => ({ name: n, value: String(value) })),
          });
        };
        push("agents", turn.integrations?.agents);
        push("composio", turn.integrations?.composio);
        push("memory", turn.integrations?.memory);
        push("workspace", turn.integrations?.workspace);
        return servers;
      };

      const sendTurn = async (turn: SendTurnInput) => {
        const { threadId } = turn;
        if (active.has(threadId)) throw new Error("a turn is already running on this thread");
        const turnId = newId();
        const cwd = turn.cwd ?? config.workspace ?? homedir();
        const env = childEnv();
        const mcpServers = acpMcpServers(turn);

        const child = spawnCliHidden(config.cli, support.spawnArgs(config, turn), {
          cwd,
          env,
          stdio: ["pipe", "pipe", "pipe"],
          detached: true,
        });

        const state = { settled: false, promptSent: false, text: "" };
        const asks = new Map<string, (behavior: string) => void>();
        let nextId = 1;
        let sessionId: string | null = null;
        let interruptTimer: ReturnType<typeof setTimeout> | null = null;
        const rpcPending = new Map<
          number,
          { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> | null }
        >();

        const send = (obj: unknown) => {
          try {
            child.stdin.write(JSON.stringify(obj) + "\n");
          } catch {}
          appendNative(threadId, { dir: "out", source: SOURCE, msg: obj });
        };
        const request = (method: string, params: unknown, timeoutMs?: number) =>
          new Promise<any>((resolve, reject) => {
            const id = nextId++;
            let timer: ReturnType<typeof setTimeout> | null = null;
            if (timeoutMs) {
              timer = setTimeout(() => {
                rpcPending.delete(id);
                reject(new Error(`${method} timed out`));
              }, timeoutMs);
              timer.unref?.();
            }
            rpcPending.set(id, { resolve, reject, timer });
            send({ jsonrpc: "2.0", id, method, params });
          });

        const stop = () => killProcessTree(child.pid);

        const settle = (ok: boolean, stopReason: string | null) => {
          if (state.settled) return;
          state.settled = true;
          if (interruptTimer) clearTimeout(interruptTimer);
          for (const finish of [...asks.values()]) finish("cancel");
          for (const p of rpcPending.values()) {
            if (p.timer) clearTimeout(p.timer);
            p.reject(new Error("turn settled"));
          }
          rpcPending.clear();
          active.delete(threadId);
          if (state.text.trim()) {
            emit({ ...base(threadId, turnId), type: "item.completed", itemType: "assistant_text", text: state.text });
          }
          emit({ ...base(threadId, turnId), type: "turn.completed", ok, stopReason, cost: null });
          stop(); // the agent process does not exit on its own
        };

        // server→client permission request → canonical request.opened
        const handleServerRequest = (msg: any) => {
          if (msg.method !== "session/request_permission") {
            // never leave an unknown server request hanging — the agent blocks
            return send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
          }
          const params = msg.params ?? {};
          const options: Array<{ optionId?: string; kind?: string }> = Array.isArray(params.options) ? params.options : [];
          const optionFor = (want: "allow" | "reject") =>
            options.find((o) => String(o.kind ?? "").startsWith(want) && typeof o.optionId === "string")?.optionId ?? null;
          const cancelled = { outcome: { outcome: "cancelled" } };
          const missing = (want: string) =>
            emit({
              ...base(threadId, turnId),
              type: "runtime.error",
              message: `${DRIVER_KIND} offered no "${want}" permission option — cancelling the request instead of guessing`,
            });

          const toolCall = params.toolCall ?? {};
          if (config.fullAuto && !turn.requireApproval) {
            const allow = optionFor("allow");
            if (!allow) missing("allow");
            return send({
              jsonrpc: "2.0",
              id: msg.id,
              result: allow ? { outcome: { outcome: "selected", optionId: allow } } : cancelled,
            });
          }
          const kind = String(toolCall.kind ?? "");
          const tool = kind === "execute" ? "shell" : kind === "edit" ? "edit" : kind || "tool";
          const summary = String(toolCall.rawInput?.command ?? toolCall.title ?? tool).slice(0, 200);
          const requestId = newId();
          const finish = (behavior: string, source?: string) => {
            if (!asks.delete(requestId)) return;
            clearTimeout(timer);
            const want = behavior === "allow" ? "allow" : "reject";
            const optionId = behavior === "cancel" ? null : optionFor(want);
            if (behavior !== "cancel" && !optionId) missing(want);
            send({
              jsonrpc: "2.0",
              id: msg.id,
              result: optionId ? { outcome: { outcome: "selected", optionId } } : cancelled,
            });
            emit({
              ...base(threadId, turnId),
              type: "request.resolved",
              requestId,
              behavior: optionId && behavior === "allow" ? "allow" : "deny",
              source: source ?? (optionId ? "user" : "system"),
            });
          };
          const timer = setTimeout(() => {
            emit({ ...base(threadId, turnId), type: "runtime.error", message: DENY_TIMEOUT_NOTE });
            finish("deny");
          }, 15 * 60_000);
          timer.unref?.();
          asks.set(requestId, finish);
          const opened = classifyOpenedRequest("permission", tool, summary);
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
          // Vendor side-channels (e.g. grok's `_x.ai/*`) are teed to the
          // native log but never normalized: the prompt result is the settle.
          if (msg.method !== "session/update") return;
          const p = msg.params ?? {};
          if (!state.promptSent || p._meta?.isReplay === true) return;
          const u = p.update ?? {};
          switch (u.sessionUpdate) {
            case "agent_message_chunk": {
              const delta = u.content?.text;
              if (typeof delta === "string" && delta) {
                state.text += delta;
                emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "assistant_text", delta });
              }
              break;
            }
            case "agent_thought_chunk": {
              const delta = u.content?.text;
              if (typeof delta === "string" && delta) {
                emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "reasoning_text", delta });
              }
              break;
            }
            case "tool_call": {
              emit({
                ...base(threadId, turnId),
                type: "item.started",
                itemType: "tool",
                itemId: u.toolCallId,
                title: String(u.rawInput?.command ?? u.title ?? "tool").slice(0, 80),
              });
              break;
            }
            case "tool_call_update": {
              if (u.status === "completed" || u.status === "failed") {
                emit({
                  ...base(threadId, turnId),
                  type: "item.completed",
                  itemType: "tool",
                  itemId: u.toolCallId,
                  ok: u.status !== "failed",
                });
              }
              break;
            }
          }
        };

        let buf = "";
        child.stdout.on("data", (chunk) => {
          buf += chunk;
          let nl;
          while ((nl = buf.indexOf("\n")) !== -1) {
            const line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            if (!line.trim()) continue;
            let msg: any;
            try {
              msg = JSON.parse(line);
            } catch {
              continue;
            }
            appendNative(threadId, { dir: "in", source: SOURCE, msg });
            if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
              const pend = rpcPending.get(msg.id);
              if (pend) {
                rpcPending.delete(msg.id);
                if (pend.timer) clearTimeout(pend.timer);
                msg.error
                  ? pend.reject(
                      Object.assign(new Error(msg.error.message ?? JSON.stringify(msg.error)), { code: msg.error.code }),
                    )
                  : pend.resolve(msg.result);
              }
            } else if (msg.id !== undefined && msg.method) {
              handleServerRequest(msg);
            } else if (msg.method) {
              handleNotification(msg);
            }
          }
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
        // A CLI that dies within milliseconds (wrong argv → usage → exit 2)
        // races the stdin writes: Node then emits an async `write EPIPE` on
        // child.stdin, and without a listener that unhandled 'error' event
        // kills the WHOLE server (rc.12 field crash). Settle instead —
        // nothing can be written to this child anymore.
        child.stdin.on("error", (e) => {
          if (state.settled) return;
          emit({ ...base(threadId, turnId), type: "runtime.error", message: `${DRIVER_KIND} stdin write failed: ${e.message}` });
          settle(false, "stdin_error");
        });
        child.on("close", (code) => {
          if (!state.settled) {
            emit({
              ...base(threadId, turnId),
              type: "runtime.error",
              message: `${DRIVER_KIND} exited ${code} before the prompt result${stderr ? `: ${stderr.trim().slice(-300)}` : ""}`,
            });
            settle(false, "exit_before_result");
          }
        });

        const interrupt = () => {
          if (sessionId) send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });
          else stop();
          if (interruptTimer) clearTimeout(interruptTimer);
          interruptTimer = setTimeout(() => settle(true, "cancelled"), 5_000);
          interruptTimer.unref?.();
        };
        active.set(threadId, { stop, interrupt, turnId, asks });
        emit({ ...base(threadId, turnId), type: "turn.started" });

        (async () => {
          try {
            const init = await request(
              "initialize",
              { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } },
              INIT_TIMEOUT,
            );
            const methods: Array<{ id?: string }> = Array.isArray(init?.authMethods) ? init.authMethods : [];
            const methodId = support.pickAuthMethod(methods);
            if (methodId) {
              try {
                await request("authenticate", { methodId }, INIT_TIMEOUT);
              } catch {
                if (support.authFailure === "fail") throw new Error(support.loginNote);
                // else: proceed on an ambient login
              }
            } else if (support.authFailure === "fail") {
              throw new Error(support.loginNote);
            }

            const cursor = typeof turn.resumeCursor === "string" ? turn.resumeCursor : null;
            if (cursor) {
              try {
                await request("session/load", { sessionId: cursor, cwd, mcpServers }, LOAD_SESSION_TIMEOUT);
                sessionId = cursor;
              } catch {
                /* session gone, load unsupported, or too slow — start fresh */
              }
            }
            if (!sessionId) {
              const started = await request("session/new", { cwd, mcpServers }, NEW_SESSION_TIMEOUT);
              sessionId = typeof started?.sessionId === "string" ? started.sessionId : null;
              if (!sessionId) throw new Error("session/new returned no sessionId");
            }
            emit({
              ...base(threadId, turnId),
              type: "session.started",
              sessionId,
              model: init?._meta?.modelState?.currentModelId ?? turn.model ?? null,
            });
            state.promptSent = true;
            const text = support.buildPromptText
              ? support.buildPromptText(turn)
              : turn.system
                ? `${turn.system}\n\n${turn.text}`
                : turn.text;
            const prompt: Array<Record<string, unknown>> = [{ type: "text", text }];
            if (agentAcceptsImagePrompts(init)) {
              prompt.push(...acpImageBlocks(turn.attachments ?? []));
            }
            const result = await request("session/prompt", {
              sessionId,
              prompt,
            });
            const usage = result?._meta ?? {};
            if (typeof usage.inputTokens === "number" || typeof usage.outputTokens === "number") {
              emit({
                ...base(threadId, turnId),
                type: "thread.token-usage.updated",
                input: usage.inputTokens ?? 0,
                output: usage.outputTokens ?? 0,
              });
            }
            const reason = result?.stopReason;
            if (reason === "end_turn") settle(true, null);
            else if (reason === "cancelled") settle(true, "cancelled");
            else settle(false, reason ?? "failed");
          } catch (e) {
            if (!state.settled) {
              const authError =
                (e as { code?: unknown }).code === ACP_AUTH_REQUIRED_CODE ||
                (e as Error).message === support.loginNote;
              const message = authError ? support.loginNote : (e as Error).message;
              emit({ ...base(threadId, turnId), type: "runtime.error", message });
              settle(false, authError ? "auth_required" : "rpc_error");
            }
          }
        })();

        return { turnId };
      };

      // Protocol-identity cache: one handshake per binary+version per
      // minute, so the model picker doesn't spawn a process per describe().
      let identityCache: { key: string; at: number; ok: boolean; detail: string } | null = null;
      const snapshot = async (): Promise<ProviderSnapshot> => {
        const env = childEnv();
        const version = await cliVersion(config.cli, 8000, env);
        if (!version) return { state: "unavailable", reason: `\`${config.cli}\` CLI not found` };
        // `--version` succeeding proves presence, not identity: a binary that
        // rejects our spawn argv (usage → exit 2) or never speaks JSON-RPC
        // would otherwise show "available" while every turn fails (rc.12
        // hermes field failure). Verify it speaks ACP on the exact argv a
        // turn uses, and surface the resolved path + version when it doesn't.
        const key = `${config.cli}@${version}`;
        if (!identityCache || identityCache.key !== key || Date.now() - identityCache.at > 60_000) {
          const probeTurn = { threadId: "acp-identity-probe", text: "" } as SendTurnInput;
          const probe = await probeProtocol(
            config.cli,
            support.spawnArgs(config, probeTurn),
            {
              jsonrpc: "2.0",
              id: 1,
              method: "initialize",
              params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } },
            },
            { timeoutMs: 8000, env },
          );
          identityCache = { key, at: Date.now(), ...probe };
        }
        if (!identityCache.ok) {
          return {
            state: "unavailable",
            reason: `\`${displayCliPath(config.cli, env)}\` (${version}) does not speak ACP with the ${support.displayName} argv — wrong or outdated CLI on PATH (${identityCache.detail})`,
          };
        }
        return { state: "available", version, authenticated: support.isAuthenticated(env) };
      };

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        displayName: input.displayName,
        enabled: input.enabled,
        models: support.models,
        snapshot,
        ...(support.generateText
          ? { generateText: (prompt: string) => support.generateText!(config, childEnv(), prompt) }
          : {}),
        adapter: {
          provider: DRIVER_KIND,
          capabilities: { sessionModelSwitch: "unsupported", agentsMcp: true },
          sendTurn,
          interruptTurn: async (threadId) => active.get(threadId)?.interrupt(),
          respondToRequest: async (threadId, requestId, decision) => {
            const turn = active.get(threadId);
            const finish = turn?.asks.get(requestId);
            if (!finish) throw new Error("no such pending request");
            finish(decision.behavior === "allow" ? "allow" : "deny", decision.source);
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
}
