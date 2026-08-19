import { createHash, randomBytes } from "node:crypto";

import type { SqliteDatabase } from "../db/sqlite-native.ts";

export const OAUTH_TRANSACTION_COOKIE_NAME = "velarix_oauth_tx";
export const OAUTH_TRANSACTION_MAX_AGE_SECONDS = 10 * 60;

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_STORED_TRANSACTIONS = 10_000;

export interface OAuthAuthorizationTransaction {
  state: string;
  cookie: string;
  codeChallenge: string;
  expiresAt: number;
}

interface ConsumedTransactionRow {
  code_verifier: string;
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function challenge(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

function validTimestamp(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

export class OAuthTransactionStore {
  private readonly db: SqliteDatabase;

  constructor(db: SqliteDatabase) {
    this.db = db;
  }

  create(now = Date.now()): OAuthAuthorizationTransaction {
    if (!validTimestamp(now)) throw new TypeError("now must be a non-negative epoch millisecond");
    const state = randomBytes(32).toString("base64url");
    const cookie = randomBytes(32).toString("base64url");
    const codeVerifier = randomBytes(32).toString("base64url");
    const expiresAt = now + OAUTH_TRANSACTION_MAX_AGE_SECONDS * 1_000;
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM github_oauth_transactions WHERE expires_at <= ?").run(now);
      const count = this.db
        .prepare<{ n: number }>("SELECT count(*) AS n FROM github_oauth_transactions")
        .get()?.n ?? 0;
      const excess = count - (MAX_STORED_TRANSACTIONS - 1);
      if (excess > 0) {
        this.db
          .prepare(
            `DELETE FROM github_oauth_transactions
             WHERE state_digest IN (
               SELECT state_digest FROM github_oauth_transactions
               ORDER BY issued_at ASC, state_digest ASC LIMIT ?
             )`,
          )
          .run(excess);
      }
      this.db
        .prepare(
          `INSERT INTO github_oauth_transactions
            (state_digest, cookie_digest, code_verifier, issued_at, expires_at, consumed_at)
           VALUES (?, ?, ?, ?, ?, NULL)`,
        )
        .run(digest(state), digest(cookie), codeVerifier, now, expiresAt);
    })();
    return { state, cookie, codeChallenge: challenge(codeVerifier), expiresAt };
  }

  /** A single conditional UPDATE makes successful validation non-replayable. */
  consume(state: unknown, cookie: unknown, now = Date.now()): { codeVerifier: string } | null {
    if (
      typeof state !== "string" ||
      typeof cookie !== "string" ||
      !TOKEN_PATTERN.test(state) ||
      !TOKEN_PATTERN.test(cookie) ||
      !validTimestamp(now)
    ) {
      return null;
    }
    const row = this.db
      .prepare<ConsumedTransactionRow>(
        `UPDATE github_oauth_transactions
         SET consumed_at = ?
         WHERE state_digest = ?
           AND cookie_digest = ?
           AND consumed_at IS NULL
           AND issued_at <= ?
           AND expires_at > ?
         RETURNING code_verifier`,
      )
      .get(now, digest(state), digest(cookie), now, now);
    return row ? { codeVerifier: row.code_verifier } : null;
  }

  prune(now = Date.now()): number {
    if (!validTimestamp(now)) throw new TypeError("now must be a non-negative epoch millisecond");
    return this.db.prepare("DELETE FROM github_oauth_transactions WHERE expires_at <= ?").run(now).changes;
  }
}

function cookieAttributes(): string {
  return "HttpOnly; SameSite=Lax; Path=/; Secure";
}

export function oauthTransactionCookie(value: string): string {
  if (!TOKEN_PATTERN.test(value)) throw new TypeError("OAuth transaction cookie is malformed");
  return `${OAUTH_TRANSACTION_COOKIE_NAME}=${value}; Max-Age=${OAUTH_TRANSACTION_MAX_AGE_SECONDS}; ${cookieAttributes()}`;
}

export function clearOAuthTransactionCookie(): string {
  return `${OAUTH_TRANSACTION_COOKIE_NAME}=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; ${cookieAttributes()}`;
}

/** Strictly extracts one transaction cookie; duplicates and malformed headers fail closed. */
export function oauthTransactionFromCookie(header: string | undefined): string | null {
  if (!header || header.length > 8_192) return null;
  let found: string | null = null;
  for (const part of header.split(";")) {
    const segment = part.trim();
    const equals = segment.indexOf("=");
    if (equals <= 0) return null;
    const name = segment.slice(0, equals).trim();
    const value = segment.slice(equals + 1).trim();
    if (name !== OAUTH_TRANSACTION_COOKIE_NAME) continue;
    if (found !== null || !TOKEN_PATTERN.test(value)) return null;
    found = value;
  }
  return found;
}
