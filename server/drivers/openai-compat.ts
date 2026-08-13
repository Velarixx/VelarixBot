// OpenAI-compatible chat-completions driver factory. OpenRouter and
// OmniRouter (and any similar BYO-key gateway) share this SSE surface.
// Keys stay in Authorization; they are never copied into argv, events,
// native logs, or error text. Missing key → snapshot unavailable, never a
// hang or a silent failover to another provider/model.
import type {
  DriverCreateInput,
  ModelCatalog,
  ProviderDriver,
  ProviderInstance,
  ProviderSnapshot,
  RuntimeEvent,
  RuntimeEventListener,
  SendTurnInput,
} from "../contracts.ts";
import { newEventId, newId } from "../contracts.ts";
import { appendNative } from "./native.ts";

export interface OpenAICompatConfig {
  url: string;
  apiKeyEnv: string;
}

export interface OpenAICompatSpec {
  driverKind: string;
  displayName: string;
  defaultUrl: string;
  defaultApiKeyEnv: string;
  models: ModelCatalog;
  extraHeaders?: Record<string, string>;
  generateTextModel?: string;
  missingKeyReason: (apiKeyEnv: string) => string;
}

type ChatJson = {
  choices?: Array<{ delta?: { content?: string }; message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};

export function scrubCompatSecret(text: string, secret?: string): string {
  let out = text.replace(/Bearer\s+\S+/gi, "Bearer [redacted]").replace(/\b(sk-or-v1-|sk-or-|sk-)[A-Za-z0-9_-]+/gi, "[redacted]");
  if (secret && secret.length >= 8) out = out.split(secret).join("[redacted]");
  return out;
}

export function decodeOpenAICompatConfig(spec: OpenAICompatSpec, raw: unknown): OpenAICompatConfig {
  if (raw !== undefined && (raw === null || typeof raw !== "object" || Array.isArray(raw))) {
    throw new Error(`${spec.driverKind}: config must be an object`);
  }
  const o = (raw ?? {}) as Record<string, unknown>;
  if (o.url !== undefined && (typeof o.url !== "string" || !o.url.trim())) {
    throw new Error(`${spec.driverKind}: url must be a non-empty string`);
  }
  if (o.apiKeyEnv !== undefined && (typeof o.apiKeyEnv !== "string" || !o.apiKeyEnv.trim())) {
    throw new Error(`${spec.driverKind}: apiKeyEnv must be a non-empty string`);
  }
  const url = (typeof o.url === "string" ? o.url : spec.defaultUrl).trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(url)) {
    throw new Error(`${spec.driverKind}: url must be http(s)`);
  }
  return {
    url,
    apiKeyEnv: typeof o.apiKeyEnv === "string" && o.apiKeyEnv.trim() ? o.apiKeyEnv.trim() : spec.defaultApiKeyEnv,
  };
}

export function createOpenAICompatDriver(spec: OpenAICompatSpec): ProviderDriver<OpenAICompatConfig> {
  const DRIVER_KIND = spec.driverKind;
  const SOURCE = `${DRIVER_KIND}.chat.completions`;

  const decodeConfig = (raw: unknown) => decodeOpenAICompatConfig(spec, raw);

  return {
    driverKind: DRIVER_KIND,
    metadata: { displayName: spec.displayName, supportsMultipleInstances: true },
    models: spec.models,
    decodeConfig,
    defaultConfig: () => decodeConfig({}),

    async create(input: DriverCreateInput<OpenAICompatConfig>): Promise<ProviderInstance> {
      const { instanceId, config } = input;
      const apiKey = input.environment[config.apiKeyEnv] ?? process.env[config.apiKeyEnv] ?? "";
      const listeners = new Set<RuntimeEventListener>();
      const active = new Map<string, { abort: AbortController; turnId: string }>();

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

      const complete = async (
        messages: Array<{ role: string; content: string }>,
        model: string,
        opts: { stream: boolean; signal?: AbortSignal; onDelta?: (d: string) => void },
      ): Promise<{ text: string; usage: { input: number; output: number } | null }> => {
        const res = await fetch(`${config.url}/chat/completions`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
            ...spec.extraHeaders,
          },
          body: JSON.stringify({ model, messages, stream: opts.stream }),
          signal: opts.signal ?? AbortSignal.timeout(120_000),
        });
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          throw new Error(
            scrubCompatSecret(`${spec.displayName} HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`, apiKey),
          );
        }
        if (!opts.stream) {
          const json = (await res.json()) as ChatJson;
          return {
            text: json.choices?.[0]?.message?.content ?? "",
            usage: json.usage
              ? { input: json.usage.prompt_tokens ?? 0, output: json.usage.completion_tokens ?? 0 }
              : null,
          };
        }
        if (!res.body) throw new Error(`${spec.displayName} HTTP ${res.status}: empty body`);
        let text = "";
        let usage: { input: number; output: number } | null = null;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let nl;
          while ((nl = buf.indexOf("\n")) !== -1) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (data === "[DONE]") continue;
            let chunk: ChatJson;
            try {
              chunk = JSON.parse(data) as ChatJson;
            } catch {
              continue;
            }
            const delta = chunk.choices?.[0]?.delta?.content;
            if (delta) {
              text += delta;
              opts.onDelta?.(delta);
            }
            if (chunk.usage) {
              usage = { input: chunk.usage.prompt_tokens ?? 0, output: chunk.usage.completion_tokens ?? 0 };
            }
          }
        }
        return { text, usage };
      };

      const sendTurn = async (turn: SendTurnInput) => {
        const { threadId } = turn;
        if (!apiKey) throw new Error(spec.missingKeyReason(config.apiKeyEnv));
        if (active.has(threadId)) throw new Error("a turn is already running on this thread");
        const turnId = newId();
        const abort = new AbortController();
        active.set(threadId, { abort, turnId });

        const messages = [
          ...(turn.system ? [{ role: "system", content: turn.system }] : []),
          ...(turn.transcript ?? []).map((m) => ({
            role: m.role === "assistant" ? "assistant" : "user",
            content: m.text,
          })),
          { role: "user", content: turn.text },
        ];
        appendNative(threadId, { dir: "out", source: SOURCE, msg: { model: turn.model, messages } });

        emit({ ...base(threadId, turnId), type: "turn.started" });
        emit({ ...base(threadId, turnId), type: "session.started", sessionId: null, model: turn.model ?? spec.models.default });

        void (async () => {
          try {
            const { text, usage } = await complete(messages, turn.model || spec.models.default, {
              stream: true,
              signal: abort.signal,
              onDelta: (delta) =>
                emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "assistant_text", delta }),
            });
            appendNative(threadId, { dir: "in", source: SOURCE, msg: { text, usage } });
            if (text.trim()) {
              emit({ ...base(threadId, turnId), type: "item.completed", itemType: "assistant_text", text });
            }
            if (usage) {
              emit({ ...base(threadId, turnId), type: "thread.token-usage.updated", ...usage });
            }
            active.delete(threadId);
            emit({ ...base(threadId, turnId), type: "turn.completed", ok: true, stopReason: null, cost: null });
          } catch (e) {
            active.delete(threadId);
            const aborted = (e as Error).name === "AbortError";
            if (!aborted) {
              emit({
                ...base(threadId, turnId),
                type: "runtime.error",
                message: scrubCompatSecret((e as Error).message, apiKey),
              });
            }
            emit({
              ...base(threadId, turnId),
              type: "turn.completed",
              ok: false,
              stopReason: aborted ? "interrupted" : "error",
              cost: null,
            });
          }
        })();

        return { turnId };
      };

      const snapshot = async (): Promise<ProviderSnapshot> => {
        if (!apiKey) {
          return { state: "unavailable", reason: spec.missingKeyReason(config.apiKeyEnv) };
        }
        return { state: "available", authenticated: true, version: null };
      };

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        displayName: input.displayName,
        enabled: input.enabled,
        models: spec.models,
        snapshot,
        adapter: {
          provider: DRIVER_KIND,
          capabilities: { sessionModelSwitch: "in-session" },
          sendTurn,
          interruptTurn: async (threadId) => {
            active.get(threadId)?.abort.abort();
          },
          respondToRequest: async () => {
            throw new Error(`${DRIVER_KIND} driver has no pending asks`);
          },
          hasSession: (threadId) => active.has(threadId),
          stopAll: async () => {
            for (const { abort } of active.values()) abort.abort();
          },
          onEvent: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
        },
        generateText: apiKey
          ? async (prompt: string) => {
              const { text } = await complete(
                [{ role: "user", content: prompt }],
                spec.generateTextModel ?? spec.models.default,
                { stream: false },
              );
              return text;
            }
          : undefined,
        dispose: async () => {
          for (const { abort } of active.values()) abort.abort();
          listeners.clear();
        },
      };
    },
  };
}
