// SecretStore unit tests. All canaries are clearly-fake values constructed
// at runtime — never credential-shaped literals in the diff.
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { DATA_DIR, ensureDirs } from "./config.ts";
import {
  createBrokerBackend,
  createFileBackend,
  initSecretStore,
  isSecretRef,
  resetSecretStoreForTests,
  secretRef,
  secretRefId,
  type BrokerPort,
} from "./secrets.ts";

const SECRETS_PATH = join(DATA_DIR, "secrets.json");

function canary(tag: string): string {
  return ["fake", tag, "canary", Date.now().toString(36), Math.random().toString(36).slice(2)].join("-");
}

/** A fake Electron-main end of the parent port: replies like the real
 * secret-broker.mjs would, with a trivially reversible fake sealer standing
 * in for safeStorage. */
function fakeSafeStoragePort(): BrokerPort & { calls: string[] } {
  const listeners: Array<(event: { data: unknown }) => void> = [];
  const calls: string[] = [];
  const SEAL_PREFIX = "sealed\u0000";
  return {
    calls,
    postMessage(message: unknown) {
      const msg = message as { velarixSecrets?: boolean; id: number; op: string; data: string };
      if (msg?.velarixSecrets !== true) return;
      calls.push(msg.op);
      const reply =
        msg.op === "encrypt"
          ? { velarixSecrets: true, id: msg.id, ok: true, data: Buffer.from(SEAL_PREFIX + msg.data, "utf8").toString("base64") }
          : msg.op === "decrypt"
            ? (() => {
                const raw = Buffer.from(msg.data, "base64").toString("utf8");
                return raw.startsWith(SEAL_PREFIX)
                  ? { velarixSecrets: true, id: msg.id, ok: true, data: raw.slice(SEAL_PREFIX.length) }
                  : { velarixSecrets: true, id: msg.id, ok: false, error: "decrypt failed" };
              })()
            : { velarixSecrets: true, id: msg.id, ok: false, error: "unknown op" };
      queueMicrotask(() => {
        for (const listener of listeners) listener({ data: reply });
      });
    },
    on(_event: "message", listener: (event: { data: unknown }) => void) {
      listeners.push(listener);
    },
  };
}

afterEach(() => resetSecretStoreForTests());

describe("secret refs", () => {
  it("round-trips ids and rejects malformed refs", () => {
    expect(secretRef("box.token")).toBe("secret://box.token");
    expect(secretRefId("secret://box.token")).toBe("box.token");
    expect(isSecretRef("secret://xai.key")).toBe(true);
    expect(isSecretRef("xai-plain-value")).toBe(false);
    expect(isSecretRef("secret://")).toBe(false);
    expect(isSecretRef("secret://../../etc/passwd")).toBe(false);
    expect(isSecretRef(42)).toBe(false);
    expect(secretRefId("secret://has space")).toBeNull();
  });
});

describe("file backend (headless/dev fallback)", () => {
  it("stores, resolves, survives a reload, and removal deletes the entry", async () => {
    ensureDirs();
    const value = canary("file");
    const store = await initSecretStore(createFileBackend());
    const ref = await store.put("box.token", value);
    expect(ref).toBe("secret://box.token");
    expect(store.resolve(ref)).toBe(value);

    // the raw store file never contains the value verbatim, and marks the
    // file backend honestly (base64, NOT encryption)
    const raw = readFileSync(SECRETS_PATH, "utf8");
    expect(raw).not.toContain(value);
    expect(JSON.parse(raw).entries["box.token"].backend).toBe("file");
    expect(JSON.parse(raw).note).toMatch(/NOT encrypted/);

    // a fresh store (server restart) resolves it again
    const reloaded = await initSecretStore(createFileBackend());
    expect(reloaded.resolve(ref)).toBe(value);

    reloaded.remove("box.token");
    expect(reloaded.resolve(ref)).toBeUndefined();
    expect(JSON.parse(readFileSync(SECRETS_PATH, "utf8")).entries["box.token"]).toBeUndefined();
    const again = await initSecretStore(createFileBackend());
    expect(again.resolve(ref)).toBeUndefined();
  });

  const posixOnly = process.platform === "win32" ? it.skip : it;
  posixOnly("keeps secrets.json 0600 — POSIX-only: Windows has no Unix 0600 mode bits", async () => {
    ensureDirs();
    const store = await initSecretStore(createFileBackend());
    await store.put("github.token", canary("mode"));
    expect(statSync(SECRETS_PATH).mode & 0o777).toBe(0o600);
  });
});

describe("safeStorage broker backend", () => {
  it("seals through the parent-port broker and unseals after a reload", async () => {
    ensureDirs();
    const value = canary("broker");
    const port = fakeSafeStoragePort();
    const store = await initSecretStore(createBrokerBackend(port));
    const ref = await store.put("xai.key", value);
    expect(store.resolve(ref)).toBe(value);
    expect(port.calls).toContain("encrypt");

    const raw = readFileSync(SECRETS_PATH, "utf8");
    expect(raw).not.toContain(value);
    expect(JSON.parse(raw).entries["xai.key"].backend).toBe("safeStorage");

    // restart with the broker available again: decrypt runs through main
    const reloaded = await initSecretStore(createBrokerBackend(fakeSafeStoragePort()));
    expect(reloaded.resolve(ref)).toBe(value);
  });

  it("headless boot leaves keychain-sealed entries intact but unresolved", async () => {
    ensureDirs();
    const value = canary("locked");
    const sealedStore = await initSecretStore(createBrokerBackend(fakeSafeStoragePort()));
    const ref = await sealedStore.put("composio.key", value);

    // dev/headless run: no broker, so the entry cannot be unsealed — it
    // resolves to undefined (configured:false) and is NOT deleted or mangled
    const headless = await initSecretStore(createFileBackend());
    expect(headless.resolve(ref)).toBeUndefined();
    expect(JSON.parse(readFileSync(SECRETS_PATH, "utf8")).entries["composio.key"].backend).toBe("safeStorage");

    // back in the packaged app the value is still there
    const packaged = await initSecretStore(createBrokerBackend(fakeSafeStoragePort()));
    expect(packaged.resolve(ref)).toBe(value);
  });

  it("upgrades file-sealed entries to the keychain when it becomes available", async () => {
    ensureDirs();
    const value = canary("upgrade");
    const fileStore = await initSecretStore(createFileBackend());
    const ref = await fileStore.put("openrouter.key", value);
    expect(JSON.parse(readFileSync(SECRETS_PATH, "utf8")).entries["openrouter.key"].backend).toBe("file");

    const upgraded = await initSecretStore(createBrokerBackend(fakeSafeStoragePort()));
    expect(upgraded.resolve(ref)).toBe(value);
    const raw = readFileSync(SECRETS_PATH, "utf8");
    expect(JSON.parse(raw).entries["openrouter.key"].backend).toBe("safeStorage");
    expect(raw).not.toContain(value);
  });
});
