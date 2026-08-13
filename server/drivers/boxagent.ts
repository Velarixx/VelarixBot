// Box agent driver — the purest form of the idea: the turn runs ON the
// bot's own cloud computer (box.ascii.dev), not on this machine. Uses the
// Box substrate's native agent facility:
//   POST /boxes/{id}/prompt   {provider: codex|claude-code, model, prompt}
//   GET  /boxes/{id}/events                work events (polled)
//   POST /boxes/{id}/asks/{askId}          allow / deny / custom answer
// The agent has the box's full desktop (Chrome, shell, disk) — the server
// separately polls screenshots so the chat shows the bot's screen live.
//
// The event payload shapes are tolerated liberally and teed verbatim to
// the native log — the same protocol-drift armor as every other driver.
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
import { appendNative } from "./native.ts";
import { HANDOFF_CONTINUE, sanitizeHandoffSummary } from "../handoff.ts";

const DRIVER_KIND = "boxAgent";
const BOX_API = "https://ascii.dev/api/box/v1";
const ASK_TIMEOUT_MS = 15 * 60_000;
const DENY_TIMEOUT_NOTE =
  "VelarixBot: nobody answered this permission request in time. Skip this action and finish what you can without it.";
const QUESTION_TIMEOUT_NOTE = "VelarixBot: nobody answered in time. Use your best judgment and continue.";

const MODELS = {
  default: "claude-fable-5",
  options: [
    { id: "claude-fable-5", label: "Claude Fable 5 · on the box" },
    { id: "sonnet", label: "Claude Sonnet · on the box" },
    { id: "gpt-5.4", label: "GPT-5.4 (Codex) · on the box" },
  ],
};

const providerFor = (model: string) => (model.startsWith("gpt") ? "codex" : "claude-code");

export interface BoxAgentConfig {
  pollMs: number;
  apiBase: string;
}

function decodeConfig(raw: unknown): BoxAgentConfig {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    pollMs: typeof o.pollMs === "number" && Number.isFinite(o.pollMs) && o.pollMs >= 0 ? o.pollMs : 2500,
    apiBase: typeof o.apiBase === "string" && o.apiBase.trim() ? o.apiBase.replace(/\/$/, "") : BOX_API,
  };
}

function isAskEvent(ev: any): boolean {
  if (!ev || typeof ev !== "object") return false;
  if (ev.ask || ev.permission || ev.approval || ev.credential || ev.handoff) return true;
  const kind = String(ev.type ?? ev.kind ?? "");
  return /ask|permission|approval|question|needs.?input|user.?input|credential|sign.?in|handoff/i.test(kind);
}

function askFromEvent(ev: any): {
  id: string;
  kind: "permission" | "question" | "credential";
  tool: string;
  summary: string;
  choices?: string[];
} {
  const nested = ev.ask ?? ev.permission ?? ev.approval ?? ev.credential ?? ev.handoff ?? ev;
  const kindRaw = String(ev.type ?? ev.kind ?? nested.kind ?? nested.type ?? "");
  const tool = String(nested.tool ?? ev.tool ?? nested.name ?? "tool");
  const summary = String(
    nested.question ?? nested.summary ?? nested.text ?? nested.message ?? nested.command ?? tool,
  ).slice(0, 300);
  const credential = /credential|sign.?in|log.?in|handoff|takeover|2fa|password/i.test(`${kindRaw} ${tool} ${summary}`);
  const kind: "permission" | "question" | "credential" = credential
    ? "credential"
    : /question|input/i.test(kindRaw) && !/permission|approval/i.test(kindRaw)
      ? "question"
      : "permission";
  const id = String(nested.id ?? nested.askId ?? ev.id ?? ev.eventId ?? newId());
  const choicesRaw = nested.choices ?? ev.choices;
  const choices = Array.isArray(choicesRaw) ? choicesRaw.map(String).slice(0, 5) : undefined;
  return { id, kind, tool, summary, choices };
}

type PendingAsk = { finish: (behavior: string, message: string | undefined, source: string) => Promise<void> };

export const BoxAgentDriver: ProviderDriver<BoxAgentConfig> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "Computer", supportsMultipleInstances: false },
  models: MODELS,
  decodeConfig,
  defaultConfig: () => decodeConfig({}),

  async create(input: DriverCreateInput<BoxAgentConfig>): Promise<ProviderInstance> {
    const { instanceId, config } = input;
    const token = input.environment.BOX_TOKEN ?? process.env.BOX_TOKEN ?? "";
    const listeners = new Set<RuntimeEventListener>();
    const active = new Map<
      string,
      { cancel: () => void; turnId: string; boxId: string; asks: Map<string, PendingAsk> }
    >();

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

    const api = async (path: string, opts: RequestInit = {}) => {
      const res = await fetch(`${config.apiBase}${path}`, {
        ...opts,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(opts.headers ?? {}) },
        signal: (opts as any).signal ?? AbortSignal.timeout(30_000),
      });
      const body: any = await res.json().catch(() => null);
      if (!res.ok || body?.ok === false) {
        throw new Error(body?.code ?? body?.error ?? `box HTTP ${res.status}`);
      }
      return body;
    };

    const sendTurn = async (turn: SendTurnInput) => {
      const { threadId } = turn;
      const boxId = turn.integrations?.computer?.boxId;
      if (!token) throw new Error('box not configured — add {"box":{"token":"…"}} to ~/.velarixbot/config.json');
      if (!boxId) throw new Error("this bot has no computer yet — open the Computer panel and provision one");
      if (active.has(threadId)) throw new Error("a turn is already running on this thread");
      const turnId = newId();
      const model = turn.model || MODELS.default;

      const prompt = [
        turn.system,
        "You are working on your own cloud computer — its desktop, Chrome, and shell are yours.",
        "",
        turn.text,
      ]
        .filter((s) => s !== undefined)
        .join("\n");

      const started: any = await api(`/boxes/${boxId}/prompt`, {
        method: "POST",
        body: JSON.stringify({ provider: providerFor(model), model, prompt }),
      });
      appendNative(threadId, { dir: "out", source: "box.prompt", msg: { model, prompt, response: started } });
      const promptId = started?.prompt?.id ?? started?.promptId ?? started?.id ?? null;

      let cancelled = false;
      const asks = new Map<string, PendingAsk>();
      const slot = {
        turnId,
        boxId,
        asks,
        cancel: () => {
          cancelled = true;
          void api(`/boxes/${boxId}/interrupt`, { method: "POST" }).catch(() => {});
        },
      };
      active.set(threadId, slot);
      emit({ ...base(threadId, turnId), type: "turn.started" });
      emit({ ...base(threadId, turnId), type: "session.started", sessionId: promptId, model });

      const openAsk = (ev: any) => {
        const ask = askFromEvent(ev);
        if (asks.has(ask.id)) return;
        const finish = async (behavior: string, message: string | undefined, source: string) => {
          const pending = asks.get(ask.id);
          if (!pending) return;
          asks.delete(ask.id);
          clearTimeout(timer);
          try {
            await api(`/boxes/${boxId}/asks/${encodeURIComponent(ask.id)}`, {
              method: "POST",
              body: JSON.stringify({ behavior, message }),
            });
          } catch {
            /* box may have moved on — the card still settles */
          }
          emit({ ...base(threadId, turnId), type: "request.resolved", requestId: ask.id, behavior, source });
        };
        const timer = setTimeout(
          () =>
            void (ask.kind === "question"
              ? finish("answer", QUESTION_TIMEOUT_NOTE, "timeout")
              : finish("deny", DENY_TIMEOUT_NOTE, "timeout")),
          ASK_TIMEOUT_MS,
        );
        timer.unref?.();
        asks.set(ask.id, { finish });
        emit({
          ...base(threadId, turnId),
          type: "request.opened",
          requestId: ask.id,
          requestType: ask.kind,
          tool: ask.tool,
          summary: ask.kind === "credential" ? sanitizeHandoffSummary(ask.summary) : ask.summary,
          choices: ask.kind === "credential" ? ask.choices ?? [HANDOFF_CONTINUE] : ask.choices,
        });
      };

      const closeAsks = (source: string) => {
        for (const pending of [...asks.values()]) {
          void pending.finish("deny", "VelarixBot: the turn ended", source);
        }
      };

      // poll events + run status until the prompt settles
      (async () => {
        const seen = new Set<string>();
        const startedAt = Date.now();
        let lastText = "";
        try {
          for (;;) {
            if (cancelled) break;
            await new Promise((r) => setTimeout(r, config.pollMs));
            const events: any = await api(`/boxes/${boxId}/events`).catch(() => null);
            const list: any[] = events?.events ?? events?.items ?? [];
            for (const ev of list) {
              const id = String(ev.id ?? ev.eventId ?? JSON.stringify(ev).slice(0, 120));
              if (seen.has(id)) continue;
              seen.add(id);
              const ask = isAskEvent(ev) ? askFromEvent(ev) : null;
              appendNative(
                threadId,
                ask?.kind === "credential"
                  ? { dir: "in", source: "box.events", msg: { type: "credential", id: ask.id, tool: ask.tool } }
                  : { dir: "in", source: "box.events", msg: ev },
              );
              if (ask) {
                openAsk(ev);
                continue;
              }
              const kind = String(ev.type ?? ev.kind ?? "");
              const text = ev.text ?? ev.message ?? ev.data?.text ?? null;
              if (/assistant|message|output/i.test(kind) && typeof text === "string" && text.trim()) {
                lastText = text;
                emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "assistant_text", delta: text });
              } else if (/tool|command|exec|browse/i.test(kind)) {
                emit({
                  ...base(threadId, turnId),
                  type: "item.started",
                  itemType: "tool",
                  itemId: id,
                  title: String(ev.title ?? ev.command ?? kind).slice(0, 80),
                });
              }
            }
            if (promptId) {
              const status: any = await api(`/boxes/${boxId}/prompts/${promptId}`).catch(() => null);
              const state = String(status?.prompt?.status ?? status?.status ?? "");
              appendNative(threadId, { dir: "in", source: "box.prompt.status", msg: status });
              if (/completed|succeeded|done/i.test(state)) {
                const result = status?.prompt?.result ?? status?.result ?? lastText;
                if (typeof result === "string" && result.trim() && result !== lastText) {
                  emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "assistant_text", delta: result });
                }
                emit({
                  ...base(threadId, turnId),
                  type: "item.completed",
                  itemType: "assistant_text",
                  text: typeof result === "string" && result.trim() ? result : lastText || "(finished)",
                });
                closeAsks("shutdown");
                active.delete(threadId);
                emit({ ...base(threadId, turnId), type: "turn.completed", ok: true, stopReason: null, cost: null });
                return;
              }
              if (/failed|error|cancelled|interrupted/i.test(state)) {
                if (lastText) {
                  emit({ ...base(threadId, turnId), type: "item.completed", itemType: "assistant_text", text: lastText });
                }
                closeAsks("shutdown");
                active.delete(threadId);
                emit({ ...base(threadId, turnId), type: "turn.completed", ok: false, stopReason: state, cost: null });
                return;
              }
            }
            if (Date.now() - startedAt > 30 * 60_000) {
              throw new Error("box run exceeded 30 minutes — interrupted");
            }
          }
          // cancelled
          closeAsks("shutdown");
          active.delete(threadId);
          emit({ ...base(threadId, turnId), type: "turn.completed", ok: false, stopReason: "interrupted", cost: null });
        } catch (e) {
          closeAsks("shutdown");
          active.delete(threadId);
          emit({ ...base(threadId, turnId), type: "runtime.error", message: (e as Error).message });
          emit({ ...base(threadId, turnId), type: "turn.completed", ok: false, stopReason: "error", cost: null });
        }
      })();

      return { turnId };
    };

    const snapshot = async (): Promise<ProviderSnapshot> => {
      if (!token) {
        return { state: "unavailable", reason: 'no Box token — add {"box":{"token":"…"}} to ~/.velarixbot/config.json' };
      }
      try {
        await api("/me");
        return { state: "available", authenticated: true, version: null };
      } catch (e) {
        return { state: "unavailable", reason: `box API unreachable: ${(e as Error).message}` };
      }
    };

    return {
      instanceId,
      driverKind: DRIVER_KIND,
      displayName: input.displayName,
      enabled: input.enabled,
      models: MODELS,
      snapshot,
      adapter: {
        provider: DRIVER_KIND,
        capabilities: { sessionModelSwitch: "in-session" },
        sendTurn,
        interruptTurn: async (threadId) => active.get(threadId)?.cancel(),
        respondToRequest: async (threadId, requestId, decision) => {
          const slot = active.get(threadId);
          if (!slot) throw new Error("no active turn with a permission broker on this thread");
          const pending = slot.asks.get(requestId);
          if (!pending) throw new Error("no such pending request (it may have timed out)");
          const behavior = decision.behavior === "answer" ? "answer" : decision.behavior;
          await pending.finish(behavior, decision.message, decision.source ?? "user");
        },
        hasSession: (threadId) => active.has(threadId),
        stopAll: async () => {
          for (const { cancel } of active.values()) cancel();
        },
        onEvent: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      dispose: async () => {
        for (const { cancel } of active.values()) cancel();
        listeners.clear();
      },
    };
  },
};
