import { describe, expect, it } from "vitest";
import {
  isTelegramRuntimeStatus,
  TELEGRAM_COPY,
  telegramDisplayedStatus,
  type TelegramConfigStatus,
} from "./telegram";

const connected: TelegramConfigStatus = {
  configured: true,
  enabled: true,
  allowlist: ["123"],
  status: "connected",
  statusMessage: TELEGRAM_COPY.connected,
};

describe("telegram displayed status", () => {
  it("surfaces an offline desktop runtime with an actionable message", () => {
    const shown = telegramDisplayedStatus(connected, false);
    expect(shown.status).toBe("offline");
    expect(shown.statusMessage).toBe(TELEGRAM_COPY.offline);
    expect(shown.statusMessage).toMatch(/Start the desktop app/i);
  });

  it("keeps the server status when the desktop runtime is connected", () => {
    const failed: TelegramConfigStatus = {
      ...connected,
      status: "connection_failed",
      statusMessage: TELEGRAM_COPY.connectionFailed("Network error."),
    };
    expect(telegramDisplayedStatus(failed, true)).toEqual({
      status: "connection_failed",
      statusMessage: failed.statusMessage,
    });
    expect(telegramDisplayedStatus(undefined, true).status).toBe("disconnected");
  });

  it("identifies the explicit runtime statuses", () => {
    expect(isTelegramRuntimeStatus("connection_failed")).toBe(true);
    expect(isTelegramRuntimeStatus("offline")).toBe(true);
    expect(isTelegramRuntimeStatus("logged_in")).toBe(false);
  });
});
