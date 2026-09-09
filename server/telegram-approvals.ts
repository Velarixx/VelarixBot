// Telegram is a second surface for an existing permission approval.
// Allow once / Deny only — not Always-allow, not a new chat product.
// Opaque callback ids map to the pending approval + choice. No credentials,
// raw command, or mutable auth in callback_data (64-byte cap).
import { randomBytes } from "node:crypto";

import { argumentPattern } from "./approvals.ts";
import { redactCommand } from "./activity-status.ts";
import { redactSecrets } from "./redact-text.ts";
import type { TelegramConversation } from "./repositories/telegram-conversations.ts";

const MAX_TELEGRAM_TEXT = 4000;

function safeText(text: string): string {
  return redactSecrets(String(text ?? "")).slice(0, MAX_TELEGRAM_TEXT);
}

function safeCommand(command: string): string {
  return safeText(redactCommand(command));
}

/** Documented expiry. Tests inject `now` — never sleep. */
export const TELEGRAM_APPROVAL_TTL_MS = 15 * 60 * 1000;

/** Telegram Bot API callback_data hard limit. */
export const TELEGRAM_CALLBACK_DATA_MAX_BYTES = 64;

export const TELEGRAM_ALLOW_ONCE_LABEL = "Allow once";
export const TELEGRAM_DENY_LABEL = "Deny";

export type TelegramApprovalChoice = "allow" | "deny";
export type TelegramApprovalTerminal = "allow" | "deny" | "expired";

export interface TelegramApprovalDisplay {
  agentName: string;
  projectLabel?: string;
  action: string;
  target: string;
}

export interface TelegramApprovalRecord extends TelegramApprovalDisplay {
  requestId: string;
  botId: string;
  threadId: string;
  chatId: string;
  userId: string;
  allowCallbackId: string;
  denyCallbackId: string;
  messageId: number | null;
  createdAt: number;
  expiresAt: number;
  settled: TelegramApprovalTerminal | null;
}

export interface TelegramInlineButton {
  text: string;
  callback_data: string;
}

export interface TelegramInlineKeyboard {
  inline_keyboard: TelegramInlineButton[][];
}

export function createOpaqueCallbackId(random: (size: number) => Buffer = randomBytes): string {
  const id = random(24).toString("base64url");
  if (Buffer.byteLength(id, "utf8") > TELEGRAM_CALLBACK_DATA_MAX_BYTES) {
    throw new Error("telegram callback id exceeds 64 bytes");
  }
  return id;
}

/** Exactly one linked conversation with a stored userId. Else do not send. */
export function soleBoundTelegramConversation(
  rows: readonly TelegramConversation[],
): TelegramConversation | null {
  if (rows.length !== 1) return null;
  const row = rows[0];
  const userId = row.userId?.trim();
  if (!userId) return null;
  return row;
}

export function telegramApprovalProjectLabel(input: {
  title?: string | null;
  sectionName?: string | null;
}): string | undefined {
  const title = typeof input.title === "string" ? input.title.trim() : "";
  const section = typeof input.sectionName === "string" ? input.sectionName.trim() : "";
  if (title && section) return `${title} · ${section}`;
  return title || section || undefined;
}

export function telegramApprovalRisk(tool: string): string {
  const name = tool.trim().toLowerCase();
  if (name === "shell" || name === "bash" || name === "exec") {
    return "Runs a command on this machine.";
  }
  if (/edit|write|delete|remove/.test(name)) return "Can change or delete files.";
  return "Needs your approval before it continues.";
}

export function formatTelegramApprovalText(input: {
  agentName: string;
  projectLabel?: string;
  action: string;
  target: string;
  risk?: string;
  terminal?: "Allow once" | "Deny" | "Expired";
}): string {
  const lines = ["Approval needed", "", `Agent: ${safeText(input.agentName)}`];
  const project = input.projectLabel?.trim();
  if (project) lines.push(`Project: ${safeText(project)}`);
  lines.push(`Action: ${safeText(input.action)}`);
  const target = safeCommand(argumentPattern(input.target));
  if (target) lines.push(`Target: ${target}`);
  lines.push(`Risk: ${safeText(input.risk ?? telegramApprovalRisk(input.action))}`);
  if (input.terminal === "Expired") {
    lines.push("", "This approval expired.");
  } else if (input.terminal) {
    lines.push("", `Decision: ${input.terminal}`);
  } else {
    lines.push("", `Expires in ${TELEGRAM_APPROVAL_TTL_MS / 60_000} minutes.`);
  }
  return safeText(lines.join("\n"));
}

export function telegramApprovalKeyboard(allowId: string, denyId: string): TelegramInlineKeyboard {
  if (
    Buffer.byteLength(allowId, "utf8") > TELEGRAM_CALLBACK_DATA_MAX_BYTES ||
    Buffer.byteLength(denyId, "utf8") > TELEGRAM_CALLBACK_DATA_MAX_BYTES
  ) {
    throw new Error("telegram callback id exceeds 64 bytes");
  }
  return {
    inline_keyboard: [
      [
        { text: TELEGRAM_ALLOW_ONCE_LABEL, callback_data: allowId },
        { text: TELEGRAM_DENY_LABEL, callback_data: denyId },
      ],
    ],
  };
}

export function telegramApprovalTerminalLabel(terminal: TelegramApprovalTerminal): "Allow once" | "Deny" | "Expired" {
  if (terminal === "allow") return "Allow once";
  if (terminal === "deny") return "Deny";
  return "Expired";
}

export function terminalFromCardAnswer(answered: string): TelegramApprovalTerminal | null {
  const value = answered.trim().toLowerCase();
  if (value === "expired") return "expired";
  if (value === "allow" || value === "allow once") return "allow";
  if (value === "deny") return "deny";
  return null;
}

export interface TelegramApprovalStore {
  create(input: {
    requestId: string;
    botId: string;
    threadId: string;
    chatId: string;
    userId: string;
    agentName: string;
    projectLabel?: string;
    action: string;
    target: string;
  }): TelegramApprovalRecord;
  getByCallback(id: string): { record: TelegramApprovalRecord; choice: TelegramApprovalChoice } | null;
  getByRequest(requestId: string): TelegramApprovalRecord | null;
  attachMessage(requestId: string, messageId: number): void;
  discard(requestId: string): void;
  settle(requestId: string, settled: TelegramApprovalTerminal): TelegramApprovalRecord | null;
  expireDue(): TelegramApprovalRecord[];
}

export function createTelegramApprovalStore(deps: {
  now: () => number;
  ttlMs?: number;
  randomId?: () => string;
}): TelegramApprovalStore {
  const ttlMs = deps.ttlMs ?? TELEGRAM_APPROVAL_TTL_MS;
  const randomId = deps.randomId ?? (() => createOpaqueCallbackId());
  const byRequest = new Map<string, TelegramApprovalRecord>();
  const byCallback = new Map<string, { requestId: string; choice: TelegramApprovalChoice }>();

  function forgetCallbacks(record: TelegramApprovalRecord) {
    byCallback.delete(record.allowCallbackId);
    byCallback.delete(record.denyCallbackId);
  }

  return {
    create(input) {
      const existing = byRequest.get(input.requestId);
      if (existing) return existing;
      const createdAt = deps.now();
      const allowCallbackId = randomId();
      const denyCallbackId = randomId();
      const record: TelegramApprovalRecord = {
        requestId: input.requestId,
        botId: input.botId,
        threadId: input.threadId,
        chatId: input.chatId,
        userId: input.userId,
        agentName: input.agentName,
        ...(input.projectLabel ? { projectLabel: input.projectLabel } : {}),
        action: input.action,
        target: input.target,
        allowCallbackId,
        denyCallbackId,
        messageId: null,
        createdAt,
        expiresAt: createdAt + ttlMs,
        settled: null,
      };
      byRequest.set(input.requestId, record);
      byCallback.set(allowCallbackId, { requestId: input.requestId, choice: "allow" });
      byCallback.set(denyCallbackId, { requestId: input.requestId, choice: "deny" });
      return record;
    },
    getByCallback(id) {
      const mapped = byCallback.get(id);
      if (!mapped) return null;
      const record = byRequest.get(mapped.requestId);
      if (!record) return null;
      return { record, choice: mapped.choice };
    },
    getByRequest(requestId) {
      return byRequest.get(requestId) ?? null;
    },
    attachMessage(requestId, messageId) {
      const record = byRequest.get(requestId);
      if (record) record.messageId = messageId;
    },
    discard(requestId) {
      const record = byRequest.get(requestId);
      if (!record) return;
      forgetCallbacks(record);
      byRequest.delete(requestId);
    },
    settle(requestId, settled) {
      const record = byRequest.get(requestId);
      if (!record || record.settled) return record ?? null;
      record.settled = settled;
      return record;
    },
    expireDue() {
      const now = deps.now();
      const expired: TelegramApprovalRecord[] = [];
      for (const record of byRequest.values()) {
        if (record.settled || now < record.expiresAt) continue;
        record.settled = "expired";
        expired.push(record);
      }
      return expired;
    },
  };
}
