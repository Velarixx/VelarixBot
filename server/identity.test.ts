import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase } from "./db/database.ts";
import type { SqliteDatabase } from "./db/sqlite-native.ts";
import {
  clearSessionCookie,
  IdentitySessions,
  MAX_SESSION_AGE_SECONDS,
  SESSION_COOKIE_NAME,
  sessionCookie,
  sessionTokenFromCookie,
} from "./identity.ts";

interface SessionRow {
  token_digest: string;
  user_id: string;
  created_at: number;
  expires_at: number;
  revoked_at: number | null;
}

describe("durable identity and sessions", () => {
  let directory: string;
  let path: string;
  let db: SqliteDatabase;
  let identity: IdentitySessions;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "velarix-identity-"));
    path = join(directory, "identity.db");
    db = openDatabase(path);
    identity = new IdentitySessions(db);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      /* already closed */
    }
    rmSync(directory, { recursive: true, force: true });
  });

  it("keeps the internal UUID stable while refreshing GitHub metadata", () => {
    const first = identity.upsertGithubIdentity(
      { githubId: 42, login: "octocat", name: "Old name", avatarUrl: "https://avatars.example/old" },
      1_000,
    );
    const refreshed = identity.upsertGithubIdentity(
      { githubId: 42, login: "the-octocat", name: "New name", avatarUrl: "https://avatars.example/new" },
      2_000,
    );

    expect(first.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(refreshed).toMatchObject({
      id: first.id,
      githubId: 42,
      login: "the-octocat",
      name: "New name",
      avatarUrl: "https://avatars.example/new",
      createdAt: 1_000,
      updatedAt: 2_000,
    });
    expect(db.prepare<{ n: number }>("SELECT count(*) AS n FROM users").get()?.n).toBe(1);
  });

  it("enforces GitHub uniqueness, immutability, session uniqueness, and foreign keys", () => {
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    const user = identity.upsertGithubIdentity({ githubId: 7, login: "seven" }, 1_000);

    expect(() =>
      db
        .prepare(
          "INSERT INTO users(id, github_id, github_login, github_name, github_avatar_url, created_at, updated_at) VALUES (?, ?, ?, NULL, NULL, ?, ?)",
        )
        .run(randomUUID(), 7, "duplicate", 1_000, 1_000),
    ).toThrow(/UNIQUE/i);
    expect(() => db.prepare("UPDATE users SET github_id = 8 WHERE id = ?").run(user.id)).toThrow(/immutable/i);
    expect(() => identity.createSession(randomUUID(), { now: 1_000, maxAgeSeconds: 60 })).toThrow(/FOREIGN KEY/i);

    const session = identity.createSession(user.id, { now: 1_000, maxAgeSeconds: 60 });
    const row = db.prepare<SessionRow>("SELECT * FROM sessions").get()!;
    expect(() =>
      db
        .prepare("INSERT INTO sessions(token_digest, user_id, created_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, NULL)")
        .run(row.token_digest, user.id, 2_000, 3_000),
    ).toThrow(/UNIQUE/i);
    expect(session.userId).toBe(user.id);
  });

  it("stores only the SHA-256 token digest and never the raw session token", () => {
    const user = identity.upsertGithubIdentity({ githubId: 99, login: "hash-test" }, 1_000);
    const session = identity.createSession(user.id, { now: 2_000, maxAgeSeconds: 120 });
    const row = db.prepare<SessionRow>("SELECT * FROM sessions").get()!;
    const columns = db
      .prepare<{ name: string }>("PRAGMA table_info(sessions)")
      .all()
      .map(({ name }) => name);

    expect(session.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(columns).toEqual(["token_digest", "user_id", "created_at", "expires_at", "revoked_at"]);
    expect(row).toEqual({
      token_digest: createHash("sha256").update(session.token).digest("hex"),
      user_id: user.id,
      created_at: 2_000,
      expires_at: 122_000,
      revoked_at: null,
    });
    expect(JSON.stringify(row)).not.toContain(session.token);
    db.pragma("wal_checkpoint(TRUNCATE)");
    expect(readFileSync(path).includes(Buffer.from(session.token))).toBe(false);
  });

  it("fails closed for malformed, missing, unknown, expired, and revoked tokens", () => {
    const user = identity.upsertGithubIdentity({ githubId: 101, login: "expiry-test" }, 1_000);
    const active = identity.createSession(user.id, { now: 2_000, maxAgeSeconds: 10 });

    expect(identity.resolveSession(active.token, 11_999)?.id).toBe(user.id);
    expect(identity.resolveSession(active.token, 12_000)).toBeNull();
    expect(identity.resolveSession(undefined, 3_000)).toBeNull();
    expect(identity.resolveSession("short", 3_000)).toBeNull();
    expect(identity.resolveSession("A".repeat(43), 3_000)).toBeNull();
    expect(identity.revokeSession("short", 3_000)).toBe(false);

    const revoked = identity.createSession(user.id, { now: 20_000, maxAgeSeconds: 10 });
    expect(identity.resolveSession(revoked.token, 21_000)?.id).toBe(user.id);
    expect(identity.revokeSession(revoked.token, 22_000)).toBe(true);
    expect(identity.resolveSession(revoked.token, 22_000)).toBeNull();
    expect(identity.revokeSession(revoked.token, 23_000)).toBe(false);
    expect(identity.pruneExpiredSessions(30_000)).toBe(2);
    expect(db.prepare<{ n: number }>("SELECT count(*) AS n FROM sessions").get()?.n).toBe(0);
  });

  it("resolves the same user after a full database restart", () => {
    const user = identity.upsertGithubIdentity({ githubId: 123_456, login: "persistent" }, 1_000);
    const session = identity.createSession(user.id, { now: 2_000, maxAgeSeconds: 60 });

    db.close();
    db = openDatabase(path);
    identity = new IdentitySessions(db);

    expect(identity.resolveSession(session.token, 3_000)).toEqual(user);
  });
});

describe("session cookie helpers", () => {
  const token = "Ab_-".repeat(10) + "Ab_";

  it("sets bounded HttpOnly SameSite cookies and Secure for SaaS/production", () => {
    expect(token).toHaveLength(43);
    const saas = sessionCookie(token, 3_600, "saas");
    expect(saas).toBe(`${SESSION_COOKIE_NAME}=${token}; Max-Age=3600; HttpOnly; SameSite=Lax; Path=/; Secure`);
    expect(sessionCookie(token, 3_600, "production")).toContain("; Secure");
    expect(sessionCookie(token, 3_600, "desktop")).not.toContain("; Secure");
    expect(() => sessionCookie(token, 0, "saas")).toThrow(/between/);
    expect(() => sessionCookie(token, MAX_SESSION_AGE_SECONDS + 1, "saas")).toThrow(/between/);
    expect(() => sessionCookie("malformed", 60, "saas")).toThrow(/malformed/);
  });

  it("clears with equivalent security attributes", () => {
    expect(clearSessionCookie("saas")).toBe(
      `${SESSION_COOKIE_NAME}=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax; Path=/; Secure`,
    );
    expect(clearSessionCookie("desktop")).not.toContain("; Secure");
  });

  it("extracts one exact cookie and rejects missing, malformed, oversized, or ambiguous headers", () => {
    expect(sessionTokenFromCookie(`theme=dark; ${SESSION_COOKIE_NAME}=${token}; locale=en`)).toBe(token);
    expect(sessionTokenFromCookie(undefined)).toBeNull();
    expect(sessionTokenFromCookie("theme=dark")).toBeNull();
    expect(sessionTokenFromCookie(`${SESSION_COOKIE_NAME}=short`)).toBeNull();
    expect(sessionTokenFromCookie(`${SESSION_COOKIE_NAME}=%41${token.slice(1)}`)).toBeNull();
    expect(sessionTokenFromCookie(`${SESSION_COOKIE_NAME}=${token}; ${SESSION_COOKIE_NAME}=${token}`)).toBeNull();
    expect(sessionTokenFromCookie(`broken; ${SESSION_COOKIE_NAME}=${token}`)).toBeNull();
    expect(sessionTokenFromCookie(`${SESSION_COOKIE_NAME}=${token}${"x".repeat(8_192)}`)).toBeNull();
  });
});
