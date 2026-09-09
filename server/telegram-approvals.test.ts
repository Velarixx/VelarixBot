// #149 first slice — opaque Telegram approval ids, sole-chat targeting,
// redacted copy, documented expiry. Fake clock. No sleeps, no live Telegram.
import { describe, expect, it } from "vitest";

import {
  TELEGRAM_ALLOW_ONCE_LABEL,
  TELEGRAM_APPROVAL_TTL_MS,
  TELEGRAM_CALLBACK_DATA_MAX_BYTES,
  TELEGRAM_DENY_LABEL,
  createOpaqueCallbackId,
  createTelegramApprovalStore,
  formatTelegramApprovalText,
  soleBoundTelegramConversation,
  telegramApprovalKeyboard,
  telegramApprovalProjectLabel,
  telegramApprovalRisk,
  telegramApprovalTerminalLabel,
  terminalFromCardAnswer,
} from "./telegram-approvals.ts";
import type { TelegramConversation } from "./repositories/telegram-conversations.ts";

function canary(tag: string): string {
  return ["fake", tag, "canary", Date.now().toString(36), Math.random().toString(36).slice(2)].join("-");
}

function telegramToken(): string {
  return `${123456789}:${"A".repeat(35)}`;
}

function row(overrides: Partial<TelegramConversation> = {}): TelegramConversation {
  return {
    chatId: "111",
    userId: "111",
    botId: "bot-1",
    threadId: "thread-1",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe("telegram approval targeting", () => {
  it("sends only when the bot has exactly one linked chat with a stored userId", () => {
    expect(soleBoundTelegramConversation([])).toBeNull();
    expect(soleBoundTelegramConversation([row({ userId: null })])).toBeNull();
    expect(soleBoundTelegramConversation([row({ userId: "   " })])).toBeNull();
    expect(
      soleBoundTelegramConversation([row({ chatId: "111" }), row({ chatId: "222", userId: "222" })]),
    ).toBeNull();
    expect(soleBoundTelegramConversation([row({ chatId: "111", userId: "42" })])).toMatchObject({
      chatId: "111",
      userId: "42",
    });
  });
});

describe("telegram approval copy + buttons", () => {
  it("includes agent, optional project, action, target, risk, and Allow once / Deny only", () => {
    const text = formatTelegramApprovalText({
      agentName: "Scout",
      projectLabel: "Ops",
      action: "shell",
      target: "git status",
    });
    expect(text).toContain("Agent: Scout");
    expect(text).toContain("Project: Ops");
    expect(text).toContain("Action: shell");
    expect(text).toContain("Target: git status");
    expect(text).toContain(telegramApprovalRisk("shell"));
    expect(text).toMatch(/Expires in 15 minutes/);
    expect(text).not.toMatch(/Always allow|workspace|Stop/i);
    expect(telegramApprovalProjectLabel({ title: "", sectionName: "" })).toBeUndefined();
    expect(telegramApprovalProjectLabel({ title: "Ops", sectionName: "Work" })).toBe("Ops · Work");

    const ids = ["cb-allow-opaque", "cb-deny-opaque"];
    const keyboard = telegramApprovalKeyboard(ids[0], ids[1]);
    const labels = keyboard.inline_keyboard.flat().map((btn) => btn.text);
    expect(labels).toEqual([TELEGRAM_ALLOW_ONCE_LABEL, TELEGRAM_DENY_LABEL]);
    expect(labels).not.toContain("Always allow");
    expect(keyboard.inline_keyboard.flat().map((btn) => btn.callback_data)).toEqual(ids);
  });

  it("redacts tokens, secrets, and command credentials from visible text", () => {
    const token = telegramToken();
    const secret = `token=${canary("approval")}`;
    const text = formatTelegramApprovalText({
      agentName: "Scout",
      action: "shell",
      target: `curl -H "Authorization: Bearer ${token}" ${secret}`,
    });
    expect(text).not.toContain(token);
    expect(text).not.toContain(secret);
    expect(text).toMatch(/\[redacted/);
  });

  it("maps terminal states for Telegram and the desktop card", () => {
    expect(telegramApprovalTerminalLabel("allow")).toBe("Allow once");
    expect(telegramApprovalTerminalLabel("deny")).toBe("Deny");
    expect(telegramApprovalTerminalLabel("expired")).toBe("Expired");
    expect(terminalFromCardAnswer("allow")).toBe("allow");
    expect(terminalFromCardAnswer("Allow once")).toBe("allow");
    expect(terminalFromCardAnswer("deny")).toBe("deny");
    expect(terminalFromCardAnswer("expired")).toBe("expired");
    expect(formatTelegramApprovalText({
      agentName: "Scout",
      action: "shell",
      target: "git status",
      terminal: "Expired",
    })).toMatch(/expired/i);
  });
});

describe("opaque callback store", () => {
  it("keeps callback_data under 64 bytes and maps it to the pending approval + choice", () => {
    const id = createOpaqueCallbackId(() => Buffer.alloc(24, 7));
    expect(Buffer.byteLength(id, "utf8")).toBeLessThanOrEqual(TELEGRAM_CALLBACK_DATA_MAX_BYTES);
    expect(id).not.toMatch(/allow|deny|token|git status/i);

    let now = 1_000;
    const store = createTelegramApprovalStore({
      now: () => now,
      randomId: (() => {
        let n = 0;
        return () => `opaque${n++}`;
      })(),
    });
    const created = store.create({
      requestId: "req-1",
      botId: "bot-1",
      threadId: "thread-1",
      chatId: "111",
      userId: "42",
      agentName: "Scout",
      action: "shell",
      target: "git status",
    });
    expect(created.expiresAt).toBe(1_000 + TELEGRAM_APPROVAL_TTL_MS);
    expect(store.getByCallback(created.allowCallbackId)).toMatchObject({ choice: "allow" });
    expect(store.getByCallback(created.denyCallbackId)).toMatchObject({ choice: "deny" });
    expect(store.getByCallback("unknown")).toBeNull();

    now += TELEGRAM_APPROVAL_TTL_MS;
    expect(store.expireDue()).toHaveLength(1);
    expect(store.getByRequest("req-1")?.settled).toBe("expired");
    expect(store.getByCallback(created.allowCallbackId)).toBeNull();
  });

  it("first settle wins; replay is a no-op", () => {
    const store = createTelegramApprovalStore({ now: () => 1 });
    const created = store.create({
      requestId: "req-1",
      botId: "bot-1",
      threadId: "thread-1",
      chatId: "111",
      userId: "42",
      agentName: "Scout",
      action: "shell",
      target: "git status",
    });
    expect(store.settle("req-1", "allow")?.settled).toBe("allow");
    expect(store.settle("req-1", "deny")?.settled).toBe("allow");
    expect(store.getByCallback(created.allowCallbackId)).toBeNull();
  });
});
