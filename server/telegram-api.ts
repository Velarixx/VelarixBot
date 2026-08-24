// Telegram Bot API client. Long-poll getUpdates — no webhook, no public
// inbound URL. The desktop runtime is the listener. Token never appears in
// thrown messages or logs.

export interface TelegramApiUser {
  id: number;
  username?: string;
}

export interface TelegramApiChat {
  id: number;
}

export interface TelegramApiMessage {
  message_id: number;
  from?: TelegramApiUser;
  chat: TelegramApiChat;
  text?: string;
}

export interface TelegramApiUpdate {
  update_id: number;
  message?: TelegramApiMessage;
}

export interface TelegramApi {
  getUpdates(token: string, offset: number, signal?: AbortSignal): Promise<TelegramApiUpdate[]>;
  sendMessage(token: string, chatId: string, text: string): Promise<void>;
}

const API_ROOT = "https://api.telegram.org";

export function redactTelegramToken(text: string, token: string): string {
  if (!token) return text;
  return text.split(token).join("[redacted]");
}

function apiUrl(token: string, method: string): string {
  return `${API_ROOT}/bot${token}/${method}`;
}

function failureMessage(status: number, body: string, token: string): string {
  const safe = redactTelegramToken(body, token);
  if (status === 401 || status === 403) {
    return "Telegram rejected the bot token. Paste a new token from @BotFather.";
  }
  if (status === 404) {
    return "Telegram did not recognize this bot. Check the token with @BotFather.";
  }
  return `Telegram returned HTTP ${status}${safe ? `: ${safe.slice(0, 180)}` : "."}`;
}

export function createTelegramApi(fetchImpl: typeof fetch = fetch): TelegramApi {
  return {
    async getUpdates(token, offset, signal) {
      const url = new URL(apiUrl(token, "getUpdates"));
      url.searchParams.set("offset", String(offset));
      url.searchParams.set("timeout", "25");
      url.searchParams.set("allowed_updates", JSON.stringify(["message"]));
      let res: Response;
      try {
        res = await fetchImpl(url, { method: "GET", signal });
      } catch (error) {
        if (signal?.aborted) throw error;
        const raw = error instanceof Error ? error.message : "network error";
        throw new Error(
          redactTelegramToken(`Could not reach api.telegram.org (${raw}). Check your network.`, token),
        );
      }
      const raw = await res.text();
      if (!res.ok) throw new Error(failureMessage(res.status, raw, token));
      let parsed: { ok?: unknown; result?: unknown };
      try {
        parsed = JSON.parse(raw) as { ok?: unknown; result?: unknown };
      } catch {
        throw new Error("Telegram returned a response that was not JSON.");
      }
      if (parsed.ok !== true || !Array.isArray(parsed.result)) {
        throw new Error("Telegram getUpdates did not return updates.");
      }
      return parsed.result as TelegramApiUpdate[];
    },

    async sendMessage(token, chatId, text) {
      let res: Response;
      try {
        res = await fetchImpl(apiUrl(token, "sendMessage"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text }),
        });
      } catch (error) {
        const raw = error instanceof Error ? error.message : "network error";
        throw new Error(
          redactTelegramToken(`Could not reach api.telegram.org (${raw}). Check your network.`, token),
        );
      }
      if (!res.ok) {
        const raw = await res.text().catch(() => "");
        throw new Error(failureMessage(res.status, raw, token));
      }
    },
  };
}
