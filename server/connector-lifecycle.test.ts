// Priority 5 pins: structured health, OAuth lifecycle, stale-auth,
// tool-list invalidation, normalized failures, redacted diagnostics,
// identity collisions. Pure in-process — no live Composio, no HOME.
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  allocateConnectorIdentity,
  cacheToolList,
  cachedToolList,
  claimConnectorIdentity,
  clearOAuth,
  currentToolListGeneration,
  detectStaleAuth,
  healthFromRemote,
  invalidateToolLists,
  markOAuth,
  normalizeConnectorFailure,
  oauthRecord,
  publicConnectorFailure,
  redactConnectorDiagnostics,
  resetConnectorLifecycleForTests,
  shouldInvalidateToolList,
  snapshotForConnector,
  writeIdentityMap,
  ConnectorError,
} from "./connector-lifecycle.ts";

beforeEach(() => {
  resetConnectorLifecycleForTests();
});

afterEach(() => {
  resetConnectorLifecycleForTests();
});

describe("structured connector health", () => {
  it("maps connected / needsAuth / error / stale with a next step", () => {
    const connected = snapshotForConnector({ slug: "gmail", remoteStatus: "ACTIVE" });
    expect(connected).toMatchObject({
      identity: "gmail",
      slug: "gmail",
      health: "connected",
      oauth: "completed",
      connected: true,
    });
    expect(connected.nextStep).toMatch(/Enable it for this bot/i);

    const needs = snapshotForConnector({ slug: "gmail", remoteStatus: "INITIATED" });
    expect(needs.health).toBe("needsAuth");
    expect(needs.connected).toBe(false);
    expect(needs.nextStep).toMatch(/finish sign-in/i);

    const stale = snapshotForConnector({ slug: "gmail", remoteStatus: "EXPIRED" });
    expect(stale.health).toBe("stale");
    expect(stale.errorCode).toBe("auth_stale");
    expect(stale.nextStep).toMatch(/expired/i);

    const errored = snapshotForConnector({ slug: "gmail", error: new Error("upstream 502") });
    expect(errored.health).toBe("error");
    expect(errored.errorCode).toBe("upstream");
    expect(errored.nextStep).toMatch(/unreachable|try again/i);
  });

  it("reports not_configured as needsAuth with an App Settings next step", () => {
    const snap = snapshotForConnector({ slug: "slack", configured: false });
    expect(snap.health).toBe("needsAuth");
    expect(snap.errorCode).toBe("not_configured");
    expect(snap.nextStep).toMatch(/App Settings/i);
  });
});

describe("OAuth lifecycle", () => {
  it("walks idle → initiated → pending → completed without storing tokens", () => {
    expect(oauthRecord("bot-a", "gmail")).toBeUndefined();
    expect(markOAuth({ botId: "bot-a", slug: "gmail" }, "initiated").phase).toBe("initiated");
    expect(markOAuth({ botId: "bot-a", slug: "gmail" }, "pending").phase).toBe("pending");
    const done = markOAuth({ botId: "bot-a", slug: "gmail", identity: "gmail" }, "completed", "connected");
    expect(done.phase).toBe("completed");
    expect(done.health).toBe("connected");
    expect(oauthRecord("bot-a", "gmail")).toEqual(done);
    expect(JSON.stringify(done)).not.toMatch(/Bearer |ck_|ak_|client_secret/i);
    clearOAuth("bot-a", "gmail");
    expect(oauthRecord("bot-a", "gmail")).toBeUndefined();
  });

  it("keeps pending OAuth as needsAuth until the remote account is ACTIVE", () => {
    markOAuth({ botId: "bot-a", slug: "gmail" }, "pending");
    const pending = healthFromRemote({
      remoteStatus: "INITIATED",
      previousOauth: oauthRecord("bot-a", "gmail")?.phase,
    });
    expect(pending).toMatchObject({ health: "needsAuth", oauth: "pending", connected: false });
    const completed = healthFromRemote({ remoteStatus: "ACTIVE", previousOauth: "pending" });
    expect(completed).toMatchObject({ health: "connected", oauth: "completed", connected: true });
  });

  it("records failed OAuth as error without echoing the authorize URL token", () => {
    const token = ["ck", "oauth", Date.now().toString(36)].join("_");
    const failed = normalizeConnectorFailure(new Error(`authorization failed redirect?code=${token}`));
    expect(failed.code).toBe("auth_failed");
    expect(failed.health).toBe("error");
    expect(failed.message).not.toContain(token);
  });
});

describe("stale-auth detection", () => {
  it("detects expired / revoked / 401 after a completed grant without echoing tokens", () => {
    expect(detectStaleAuth({ remoteStatus: "EXPIRED" })).toBe(true);
    expect(detectStaleAuth({ remoteStatus: "REVOKED" })).toBe(true);
    expect(
      detectStaleAuth({
        previousOauth: "completed",
        previousHealth: "connected",
        remoteStatus: "INITIATED",
      }),
    ).toBe(true);
    const secret = ["Bearer", "live", Date.now().toString(36)].join(" ");
    expect(
      detectStaleAuth({
        previousHealth: "connected",
        httpStatus: 401,
        errorMessage: `unauthorized ${secret}`,
      }),
    ).toBe(true);
    expect(detectStaleAuth({ remoteStatus: "ACTIVE" })).toBe(false);
    expect(detectStaleAuth({ remoteStatus: "INITIATED" })).toBe(false);
  });

  it("marks a previously connected account stale and invalidates tools", () => {
    cacheToolList("gmail", [{ name: "GMAIL_SEND_EMAIL" }]);
    const snap = snapshotForConnector({
      slug: "gmail",
      remoteStatus: "TOKEN_EXPIRED",
      previousHealth: "connected",
      previousOauth: "completed",
    });
    expect(snap.health).toBe("stale");
    expect(snap.errorCode).toBe("auth_stale");
    expect(JSON.stringify(snap)).not.toMatch(/Bearer |TOKEN=/i);
    expect(shouldInvalidateToolList(snap)).toBe(true);
    const gen = invalidateToolLists("stale");
    expect(gen).toBe(1);
    expect(cachedToolList("gmail")).toBeNull();
  });
});

describe("tool-list invalidation", () => {
  it("returns a cache hit until reconnect or auth change bumps the generation", () => {
    const tools = [{ name: "GOOGLEDRIVE_LIST_FILES" }];
    cacheToolList("googledrive", tools);
    expect(cachedToolList("googledrive")).toEqual(tools);
    expect(currentToolListGeneration()).toBe(0);

    const afterAuth = invalidateToolLists("auth_change");
    expect(afterAuth).toBe(1);
    expect(cachedToolList("googledrive")).toBeNull();

    cacheToolList("googledrive", tools, afterAuth);
    expect(cachedToolList("googledrive")).toEqual(tools);

    const afterReconnect = invalidateToolLists("reconnect");
    expect(afterReconnect).toBe(2);
    expect(cachedToolList("googledrive")).toBeNull();
    expect(cachedToolList("googledrive", afterAuth)).toBeNull();
  });

  it("disconnect invalidates the cached list for that generation", () => {
    cacheToolList("slack", [{ name: "SLACK_SEND" }]);
    invalidateToolLists("disconnect");
    expect(cachedToolList("slack")).toBeNull();
    expect(currentToolListGeneration()).toBe(1);
  });
});

describe("normalized failures", () => {
  it("maps failures onto the small error-code set", () => {
    expect(normalizeConnectorFailure(new ConnectorError("identity_collision", "claimed")).code).toBe(
      "identity_collision",
    );
    expect(normalizeConnectorFailure(new Error("no Composio key configured")).code).toBe("not_configured");
    expect(normalizeConnectorFailure(new Error("TimeoutError: aborted")).code).toBe("timeout");
    expect(normalizeConnectorFailure(Object.assign(new Error("aborted"), { name: "TimeoutError" })).code).toBe(
      "timeout",
    );
    expect(normalizeConnectorFailure(new Error("HTTP 401 unauthorized")).code).toBe("auth_stale");
    expect(normalizeConnectorFailure(new Error("authorization failed")).code).toBe("auth_failed");
    expect(normalizeConnectorFailure(new Error("ECONNREFUSED 127.0.0.1")).code).toBe("upstream");
    const codes = [
      "not_configured",
      "auth_required",
      "auth_stale",
      "auth_failed",
      "identity_collision",
      "upstream",
      "timeout",
    ];
    for (const code of codes) {
      expect(normalizeConnectorFailure(new ConnectorError(code as never, code)).code).toBe(code);
    }
  });
});

describe("redacted diagnostics", () => {
  it("strips bearer, cookies, client secrets, and key-shaped values", () => {
    const nonce = `xyzzy${Date.now().toString(36)}`;
    const bearer = ["Bearer", nonce].join(" ");
    const cookie = `session=${["sess", nonce].join("_")}`;
    const client = ["cs", "live", nonce].join("_");
    const access = ["at", "live", nonce].join("_");
    const consumer = ["ck", "test", nonce].join("_");
    const payload = {
      authorization: bearer,
      headers: { Cookie: cookie, "x-consumer-api-key": consumer },
      body: `client_secret=${client}&access_token=${access}`,
      note: "the key to this diagnosis",
    };
    const out = JSON.stringify(redactConnectorDiagnostics(payload));
    expect(out).not.toContain(nonce);
    expect(out).not.toContain(cookie);
    expect(out).not.toContain(client);
    expect(out).not.toContain(access);
    expect(out).not.toContain(consumer);
    expect(out).toContain("the key to this diagnosis");
    expect(out).toMatch(/redacted/i);
  });

  it("keeps public failure payloads free of secrets", () => {
    const token = ["ck", "leaked", Date.now().toString(36)].join("_");
    const pub = publicConnectorFailure(new Error(`Composio MCP: HTTP 401 ${token}`));
    expect(pub.errorCode).toBe("auth_stale");
    expect(JSON.stringify(pub)).not.toContain(token);
    expect(pub.nextStep).toMatch(/expired|Connect again/i);
  });
});

describe("identity collisions", () => {
  it("suffixes a second account on the same slug so the first is not overwritten", () => {
    const first = allocateConnectorIdentity([], "gmail", "acc_1");
    expect(first).toEqual({ identity: "gmail", suffixed: false });
    const second = allocateConnectorIdentity([{ identity: first.identity, accountKey: "acc_1" }], "gmail", "acc_2");
    expect(second.suffixed).toBe(true);
    expect(second.identity).toBe("gmail:acc_2");
    expect(second.identity).not.toBe(first.identity);
  });

  it("rejects claiming the bare slug when another account already holds it", () => {
    const claimed = [{ identity: "gmail", accountKey: "acc_1" }];
    const reclaim = claimConnectorIdentity(claimed, "gmail", "acc_1");
    expect(reclaim).toEqual({ identity: "gmail" });
    const collide = claimConnectorIdentity(claimed, "gmail", "acc_9");
    expect(collide).toMatchObject({ collision: true, identity: "gmail" });
    const bare = claimConnectorIdentity(claimed, "gmail");
    expect(bare).toMatchObject({ collision: true, identity: "gmail" });
  });

  it("writeIdentityMap refuses to silently overwrite", () => {
    const map: Record<string, { id: string }> = {};
    expect(writeIdentityMap(map, "gmail", { id: "a" })).toEqual({ ok: true });
    expect(writeIdentityMap(map, "gmail", { id: "b" })).toEqual({
      ok: false,
      code: "identity_collision",
      identity: "gmail",
    });
    expect(map.gmail).toEqual({ id: "a" });
    const alt = allocateConnectorIdentity([{ identity: "gmail", accountKey: "a" }], "gmail", "b");
    expect(writeIdentityMap(map, alt.identity, { id: "b" })).toEqual({ ok: true });
    expect(map[alt.identity]).toEqual({ id: "b" });
    expect(map.gmail).toEqual({ id: "a" });
  });
});
