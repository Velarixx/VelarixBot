// Durable identity/session primitives for a later GitHub OAuth callback.
// This module intentionally has no HTTP routes: the existing desktop launch
// bearer remains the only credential accepted by the loopback API. The next
// integration must exchange GitHub's numeric identity through
// upsertGithubIdentity(), set the returned session token as a cookie, and then
// propagate the resolved internal user.id through every product repository and
// VM/workspace lookup before exposing any SaaS endpoint.
import { createHash, randomBytes, randomUUID } from "node:crypto";

import type { SqliteDatabase } from "./db/sqlite-native.ts";

export const SESSION_COOKIE_NAME = "velarix_session";
export const MAX_SESSION_AGE_SECONDS = 60 * 60 * 24 * 30;

const SESSION_TOKEN_BYTES = 32;
const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface GithubIdentity {
  githubId: number;
  login: string;
  name?: string | null;
  avatarUrl?: string | null;
}

export interface IdentityUser {
  id: string;
  githubId: number;
  login: string;
  name: string | null;
  avatarUrl: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface CreatedSession {
  token: string;
  userId: string;
  createdAt: number;
  expiresAt: number;
}

interface UserRow {
  id: string;
  github_id: number;
  github_login: string;
  github_name: string | null;
  github_avatar_url: string | null;
  created_at: number;
  updated_at: number;
}

function toUser(row: UserRow): IdentityUser {
  return {
    id: row.id,
    githubId: row.github_id,
    login: row.github_login,
    name: row.github_name,
    avatarUrl: row.github_avatar_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function requiredMetadata(value: string, field: string, maxLength: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw new TypeError(`${field} must contain 1-${maxLength} characters`);
  }
  return normalized;
}

function optionalMetadata(value: string | null | undefined, field: string, maxLength: number): string | null {
  if (value === undefined || value === null) return null;
  const normalized = value.trim();
  if (normalized.length > maxLength) throw new TypeError(`${field} must not exceed ${maxLength} characters`);
  return normalized || null;
}

function assertEpochMillis(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${field} must be a non-negative epoch millisecond`);
}

function assertSessionAge(maxAgeSeconds: number): void {
  if (!Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds < 1 || maxAgeSeconds > MAX_SESSION_AGE_SECONDS) {
    throw new RangeError(`maxAgeSeconds must be between 1 and ${MAX_SESSION_AGE_SECONDS}`);
  }
}

function validSessionToken(token: unknown): token is string {
  return typeof token === "string" && SESSION_TOKEN_PATTERN.test(token);
}

function sessionDigest(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Repository/service boundary shared by the future OAuth callback and auth middleware. */
export class IdentitySessions {
  constructor(private readonly db: SqliteDatabase) {}

  upsertGithubIdentity(identity: GithubIdentity, now = Date.now()): IdentityUser {
    if (!Number.isSafeInteger(identity.githubId) || identity.githubId <= 0) {
      throw new TypeError("githubId must be a positive safe integer");
    }
    assertEpochMillis(now, "now");
    const login = requiredMetadata(identity.login, "login", 255);
    const name = optionalMetadata(identity.name, "name", 255);
    const avatarUrl = optionalMetadata(identity.avatarUrl, "avatarUrl", 2_048);
    const candidateId = randomUUID();

    this.db
      .prepare(
        `INSERT INTO users(id, github_id, github_login, github_name, github_avatar_url, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(github_id) DO UPDATE SET
           github_login = excluded.github_login,
           github_name = excluded.github_name,
           github_avatar_url = excluded.github_avatar_url,
           updated_at = excluded.updated_at`,
      )
      .run(candidateId, identity.githubId, login, name, avatarUrl, now, now);

    const row = this.db
      .prepare<UserRow>(
        `SELECT id, github_id, github_login, github_name, github_avatar_url, created_at, updated_at
         FROM users WHERE github_id = ?`,
      )
      .get(identity.githubId);
    if (!row) throw new Error("GitHub identity upsert did not return a user");
    return toUser(row);
  }

  createSession(
    userId: string,
    options: { now?: number; maxAgeSeconds?: number } = {},
  ): CreatedSession {
    if (!UUID_PATTERN.test(userId)) throw new TypeError("userId must be an internal UUID");
    const createdAt = options.now ?? Date.now();
    const maxAgeSeconds = options.maxAgeSeconds ?? MAX_SESSION_AGE_SECONDS;
    assertEpochMillis(createdAt, "now");
    assertSessionAge(maxAgeSeconds);
    const expiresAt = createdAt + maxAgeSeconds * 1_000;
    if (!Number.isSafeInteger(expiresAt)) throw new RangeError("session expiry exceeds the safe timestamp range");

    const token = randomBytes(SESSION_TOKEN_BYTES).toString("base64url");
    this.db
      .prepare("INSERT INTO sessions(token_digest, user_id, created_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, NULL)")
      .run(sessionDigest(token), userId, createdAt, expiresAt);
    return { token, userId, createdAt, expiresAt };
  }

  /** All invalid, unknown, expired, and revoked credentials collapse to null. */
  resolveSession(token: unknown, now = Date.now()): IdentityUser | null {
    if (!validSessionToken(token) || !Number.isSafeInteger(now) || now < 0) return null;
    const row = this.db
      .prepare<UserRow>(
        `SELECT u.id, u.github_id, u.github_login, u.github_name, u.github_avatar_url, u.created_at, u.updated_at
         FROM sessions s
         JOIN users u ON u.id = s.user_id
         WHERE s.token_digest = ? AND s.revoked_at IS NULL AND s.expires_at > ?`,
      )
      .get(sessionDigest(token), now);
    return row ? toUser(row) : null;
  }

  revokeSession(token: unknown, now = Date.now()): boolean {
    if (!validSessionToken(token) || !Number.isSafeInteger(now) || now < 0) return false;
    return (
      this.db
        .prepare("UPDATE sessions SET revoked_at = ? WHERE token_digest = ? AND revoked_at IS NULL AND created_at <= ?")
        .run(now, sessionDigest(token), now).changes > 0
    );
  }

  pruneExpiredSessions(now = Date.now()): number {
    assertEpochMillis(now, "now");
    return this.db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now).changes;
  }
}

export type SessionCookieMode = "desktop" | "saas" | "production";

function cookieAttributes(mode: SessionCookieMode): string[] {
  const attributes = ["HttpOnly", "SameSite=Lax", "Path=/"];
  if (mode === "saas" || mode === "production") {
    attributes.push("Secure");
  } else if (mode !== "desktop") {
    throw new TypeError("cookie mode must be desktop, saas, or production");
  }
  return attributes;
}

export function sessionCookie(token: string, maxAgeSeconds: number, mode: SessionCookieMode): string {
  if (!validSessionToken(token)) throw new TypeError("session token is malformed");
  assertSessionAge(maxAgeSeconds);
  return `${SESSION_COOKIE_NAME}=${token}; Max-Age=${maxAgeSeconds}; ${cookieAttributes(mode).join("; ")}`;
}

export function clearSessionCookie(mode: SessionCookieMode): string {
  return `${SESSION_COOKIE_NAME}=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; ${cookieAttributes(mode).join("; ")}`;
}

/** Strict Cookie-header parser: ambiguity and malformed values fail closed. */
export function sessionTokenFromCookie(header: string | undefined): string | null {
  if (!header || header.length > 8_192) return null;
  let found: string | null = null;
  for (const part of header.split(";")) {
    const segment = part.trim();
    const equals = segment.indexOf("=");
    if (equals <= 0) return null;
    const name = segment.slice(0, equals).trim();
    const value = segment.slice(equals + 1).trim();
    if (name !== SESSION_COOKIE_NAME) continue;
    if (found !== null || !validSessionToken(value)) return null;
    found = value;
  }
  return found;
}
