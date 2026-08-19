import { randomBytes } from "node:crypto";

/** 16 random bytes encode to exactly 22 unpadded base64url characters. */
export const PUBLIC_BOT_HANDLE_ENTROPY_BITS = 128;
export const PUBLIC_BOT_HANDLE_LENGTH = 22;
export const PUBLIC_BOT_HANDLE_PATTERN = /^[A-Za-z0-9_-]{22}$/;
export const PUBLIC_BOT_HANDLE_GENERATION_ATTEMPTS = 16;

export function isPublicBotHandle(value: unknown): value is string {
  return typeof value === "string" && PUBLIC_BOT_HANDLE_PATTERN.test(value);
}

/** Opaque identifier only. Authorization must still bind every lookup to an owner. */
export function generatePublicBotHandle(): string {
  return randomBytes(PUBLIC_BOT_HANDLE_ENTROPY_BITS / 8).toString("base64url");
}
