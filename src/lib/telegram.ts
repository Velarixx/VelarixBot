/** Client-safe Telegram integration types. Mirrors server/telegram.ts —
 * do not import the server module from the client (it uses `.ts` extensions). */

export const TELEGRAM_RUNTIME_STATUSES = [
  "disconnected",
  "connecting",
  "connected",
  "connection_failed",
  "offline",
] as const;

export type TelegramRuntimeStatus = (typeof TELEGRAM_RUNTIME_STATUSES)[number];

export interface TelegramConfigStatus {
  configured: boolean;
  enabled: boolean;
  defaultBotId?: string;
  allowlist: string[];
  status: TelegramRuntimeStatus;
  statusMessage: string;
}

export const TELEGRAM_COPY = {
  disconnected:
    "Telegram is disconnected. Paste a bot token from @BotFather, pick an agent, and add an allowlist to connect.",
  connecting: "Connecting to Telegram…",
  connected: "Telegram is connected. Authorized chats can message the selected agent.",
  connectedEmptyAllowlist:
    "Connected to Telegram, but the allowlist is empty. Add a Telegram user ID or chat ID or nobody is authorized.",
  noAgent: "No agent is selected. Choose which VelarixBot agent receives Telegram conversations.",
  offline:
    "VelarixBot is offline. Start the desktop app so Telegram messages can be received and answered.",
  unauthorized: "You are not authorized to use this VelarixBot.",
  connectionFailed(detail: string): string {
    return `Could not reach Telegram. ${detail} Messages wait until this desktop runtime can connect again.`;
  },
};

export function isTelegramRuntimeStatus(value: unknown): value is TelegramRuntimeStatus {
  return typeof value === "string" && (TELEGRAM_RUNTIME_STATUSES as readonly string[]).includes(value);
}

/** Settings UI status: an unreachable desktop runtime wins over a live poll. */
export function telegramDisplayedStatus(
  telegram: TelegramConfigStatus | undefined,
  desktopConnected: boolean,
): { status: TelegramRuntimeStatus; statusMessage: string } {
  if (!desktopConnected) {
    return { status: "offline", statusMessage: TELEGRAM_COPY.offline };
  }
  if (!telegram) {
    return { status: "disconnected", statusMessage: TELEGRAM_COPY.disconnected };
  }
  return { status: telegram.status, statusMessage: telegram.statusMessage };
}
