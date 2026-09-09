// Telegram Bot API client. Long-poll getUpdates — no webhook, no public
// inbound URL. The desktop runtime is the listener. Token never appears in
// thrown messages or logs.

import type { TelegramInlineKeyboard } from "./telegram-approvals.ts";

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

export interface TelegramApiCallbackQuery {
  id: string;
  from: TelegramApiUser;
  message?: TelegramApiMessage;
  data?: string;
}

export interface TelegramApiUpdate {
  update_id: number;
  message?: TelegramApiMessage;
  callback_query?: TelegramApiCallbackQuery;
}

export interface TelegramSendOptions {
  replyMarkup?: TelegramInlineKeyboard;
}

export interface TelegramSentMessage {
  messageId: number;
}

export interface TelegramApi {
  getUpdates(token: string, offset: number, signal?: AbortSignal): Promise<TelegramApiUpdate[]>;
  sendMessage(
    token: string,
    chatId: string,
    text: string,
    options?: TelegramSendOptions,
  ): Promise<TelegramSentMessage>;
  editMessageText(token: string, chatId: string, messageId: number, text: string): Promise<void>;
  answerCallbackQuery(token: string, callbackQueryId: string, text?: string): Promise<void>;
}

const API_ROOT = "https://api.telegram.org";
export const TELEGRAM_ALLOWED_UPDATES = ["message", "callback_query"] as const;

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

async function telegramFetch(
  fetchImpl: typeof fetch,
  token: string,
  url: string,
  init: RequestInit,
): Promise<Response> {
  let res: Response;
  try {
    res = await fetchImpl(url, init);
  } catch (error) {
    if (init.signal?.aborted) throw error;
    const raw = error instanceof Error ? error.message : "network error";
    throw new Error(
      redactTelegramToken(`Could not reach api.telegram.org (${raw}). Check your network.`, token),
    );
  }
  if (!res.ok) {
    const raw = await res.text().catch(() => "");
    throw new Error(failureMessage(res.status, raw, token));
  }
  return res;
}

function parseJson(raw: string): { ok?: unknown; result?: unknown } {
  try {
    return JSON.parse(raw) as { ok?: unknown; result?: unknown };
  } catch {
    throw new Error("Telegram returned a response that was not JSON.");
  }
}

export function createTelegramApi(fetchImpl: typeof fetch = fetch): TelegramApi {
  return {
    async getUpdates(token, offset, signal) {
      const url = new URL(apiUrl(token, "getUpdates"));
      url.searchParams.set("offset", String(offset));
      url.searchParams.set("timeout", "25");
      url.searchParams.set("allowed_updates", JSON.stringify([...TELEGRAM_ALLOWED_UPDATES]));
      const res = await telegramFetch(fetchImpl, token, url.toString(), { method: "GET", signal });
      const raw = await res.text();
      const parsed = parseJson(raw);
      if (parsed.ok !== true || !Array.isArray(parsed.result)) {
        throw new Error("Telegram getUpdates did not return updates.");
      }
      return parsed.result as TelegramApiUpdate[];
    },

    async sendMessage(token, chatId, text, options) {
      const body: Record<string, unknown> = { chat_id: chatId, text };
      if (options?.replyMarkup) body.reply_markup = options.replyMarkup;
      const res = await telegramFetch(fetchImpl, token, apiUrl(token, "sendMessage"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const parsed = parseJson(await res.text());
      const message = parsed.result as { message_id?: unknown } | undefined;
      const messageId = typeof message?.message_id === "number" ? message.message_id : 0;
      return { messageId };
    },

    async editMessageText(token, chatId, messageId, text) {
      await telegramFetch(fetchImpl, token, apiUrl(token, "editMessageText"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          message_id: messageId,
          text,
          reply_markup: { inline_keyboard: [] },
        }),
      });
    },

    async answerCallbackQuery(token, callbackQueryId, text) {
      await telegramFetch(fetchImpl, token, apiUrl(token, "answerCallbackQuery"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          callback_query_id: callbackQueryId,
          ...(text ? { text } : {}),
        }),
      });
    },
  };
}
