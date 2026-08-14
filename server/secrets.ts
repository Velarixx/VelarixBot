// P1.5 OS-backed SecretStore. config.json holds `secret://<id>` references;
// the actual values live in ~/.velarixbot/secrets.json as sealed entries:
//
//   { "version": 1, "entries": { "box.token": { "backend": "safeStorage",
//     "data": "<base64>" } } }
//
// Two sealing backends, no invented crypto:
//   - "safeStorage" — Electron's OS keychain crypto (macOS Keychain, Windows
//     DPAPI, Linux libsecret/kwallet). safeStorage only exists in the Electron
//     MAIN process, and the packaged server runs as a utilityProcess — so the
//     server brokers encrypt/decrypt over its parent port (main answers with
//     electron/secret-broker.mjs). Main advertises the capability by setting
//     VELARIX_SAFE_STORAGE=1 on the fork.
//   - "file" — the documented headless/dev fallback (plain `node server/index.ts`,
//     or Linux without a secret store): the sealed bytes are just base64 of the
//     value. That is NOT encryption — it is the same trust level as the old
//     plaintext config.json (0600 file, OS account is the boundary) — but it
//     keeps plaintext out of config.json and gives one migration path. When the
//     packaged app later runs with safeStorage available, file-sealed entries
//     are upgraded to keychain-sealed automatically on boot.
//
// Values never touch logs, argv, or API responses; the store file is 0600 and
// written atomically like config.json.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { atomicWriteFileSync, ensurePrivateDir } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";

export const SECRET_REF_PREFIX = "secret://";
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const FILE_NOTE =
  "file-backend entries are base64 of the value, NOT encrypted — written when no OS keychain (Electron safeStorage) was available. Keep this file private; it is 0600 like config.json.";

export type SecretBackendName = "safeStorage" | "file";

export interface SecretBackend {
  name: SecretBackendName;
  seal(plaintext: string): Promise<Buffer>;
  unseal(sealed: Buffer): Promise<string>;
}

interface SealedEntry {
  backend: SecretBackendName;
  data: string;
}

// deliberately NOT a type predicate: `isSecretRef(v) === false` must leave
// v as a possible plaintext string, not narrow it away
export function isSecretRef(value: unknown): boolean {
  return typeof value === "string" && value.startsWith(SECRET_REF_PREFIX) && secretRefId(value) !== null;
}

export function secretRef(id: string): string {
  return `${SECRET_REF_PREFIX}${id}`;
}

export function secretRefId(ref: string): string | null {
  if (typeof ref !== "string" || !ref.startsWith(SECRET_REF_PREFIX)) return null;
  const id = ref.slice(SECRET_REF_PREFIX.length);
  return ID_RE.test(id) ? id : null;
}

function secretsPath(): string {
  return join(DATA_DIR, "secrets.json");
}

/** The headless/dev fallback: sealed bytes are the value's utf8 bytes. */
export function createFileBackend(): SecretBackend {
  return {
    name: "file",
    seal: (plaintext) => Promise.resolve(Buffer.from(plaintext, "utf8")),
    unseal: (sealed) => Promise.resolve(sealed.toString("utf8")),
  };
}

/** The message-port surface of a utilityProcess parent (process.parentPort). */
export interface BrokerPort {
  postMessage(message: unknown): void;
  on(event: "message", listener: (event: { data: unknown }) => void): void;
}

/** Electron-main-brokered safeStorage: encrypt/decrypt run in the main
 * process (electron/secret-broker.mjs); this side only ships base64 over
 * the in-app parent port. */
export function createBrokerBackend(port: BrokerPort, timeoutMs = 10_000): SecretBackend {
  let seq = 0;
  const pending = new Map<number, { resolve: (data: string) => void; reject: (err: Error) => void }>();
  port.on("message", (event) => {
    const msg = event?.data as { velarixSecrets?: unknown; id?: unknown; ok?: unknown; data?: unknown; error?: unknown } | null;
    if (!msg || msg.velarixSecrets !== true || typeof msg.id !== "number") return;
    const waiter = pending.get(msg.id);
    if (!waiter) return;
    pending.delete(msg.id);
    if (msg.ok === true && typeof msg.data === "string") waiter.resolve(msg.data);
    else waiter.reject(new Error(typeof msg.error === "string" ? msg.error : "secret broker error"));
  });
  const call = (op: "encrypt" | "decrypt", data: string): Promise<string> =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("secret broker timed out"));
      }, timeoutMs);
      timer.unref?.();
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      port.postMessage({ velarixSecrets: true, id, op, data });
    });
  return {
    name: "safeStorage",
    seal: async (plaintext) => Buffer.from(await call("encrypt", plaintext), "base64"),
    unseal: async (sealed) => call("decrypt", sealed.toString("base64")),
  };
}

export class SecretStore {
  private readonly backend: SecretBackend;
  private readonly cache = new Map<string, string>();
  private entries: Record<string, SealedEntry> = {};

  constructor(backend: SecretBackend) {
    this.backend = backend;
    this.loadEntriesSync();
  }

  backendName(): SecretBackendName {
    return this.backend.name;
  }

  /** Read secrets.json and unseal what needs no broker round-trip
   * (file-backend entries) so a lazily-created store works synchronously. */
  private loadEntriesSync(): void {
    this.entries = {};
    try {
      const parsed = JSON.parse(readFileSync(secretsPath(), "utf8")) as { entries?: Record<string, SealedEntry> };
      if (parsed && typeof parsed === "object" && parsed.entries && typeof parsed.entries === "object") {
        for (const [id, entry] of Object.entries(parsed.entries)) {
          if (!ID_RE.test(id) || !entry || typeof entry.data !== "string") continue;
          if (entry.backend !== "safeStorage" && entry.backend !== "file") continue;
          this.entries[id] = { backend: entry.backend, data: entry.data };
        }
      }
    } catch {
      /* first run — empty store */
    }
    for (const [id, entry] of Object.entries(this.entries)) {
      if (entry.backend === "file") this.cache.set(id, Buffer.from(entry.data, "base64").toString("utf8"));
    }
  }

  /** Unseal keychain-sealed entries through the broker, and upgrade
   * file-sealed entries to the keychain when it is available. Entries this
   * process cannot unseal (keychain-sealed, running headless) stay on disk
   * untouched and simply resolve to undefined — configured:false, honest. */
  async unsealAll(): Promise<void> {
    let upgraded = false;
    for (const [id, entry] of Object.entries(this.entries)) {
      if (entry.backend === "safeStorage") {
        if (this.backend.name !== "safeStorage" || this.cache.has(id)) continue;
        try {
          this.cache.set(id, await this.backend.unseal(Buffer.from(entry.data, "base64")));
        } catch {
          /* keychain refused (locked, different machine key) — leave sealed */
        }
      } else if (entry.backend === "file" && this.backend.name === "safeStorage") {
        const value = this.cache.get(id);
        if (value === undefined) continue;
        try {
          const sealed = await this.backend.seal(value);
          this.entries[id] = { backend: "safeStorage", data: sealed.toString("base64") };
          upgraded = true;
        } catch {
          /* keep the file-sealed entry — still resolvable */
        }
      }
    }
    if (upgraded) this.write();
  }

  has(id: string): boolean {
    return this.cache.has(id);
  }

  /** Sync resolution from the unsealed cache — loadConfig() stays sync. */
  resolve(ref: string): string | undefined {
    const id = secretRefId(ref);
    return id === null ? undefined : this.cache.get(id);
  }

  async put(id: string, value: string): Promise<string> {
    if (!ID_RE.test(id)) throw new Error(`invalid secret id`);
    const sealed = await this.backend.seal(value);
    this.entries[id] = { backend: this.backend.name, data: sealed.toString("base64") };
    this.cache.set(id, value);
    this.write();
    return secretRef(id);
  }

  remove(id: string): void {
    if (!(id in this.entries) && !this.cache.has(id)) return;
    delete this.entries[id];
    this.cache.delete(id);
    this.write();
  }

  private write(): void {
    ensurePrivateDir(DATA_DIR);
    const body: Record<string, unknown> = { version: 1 };
    if (Object.values(this.entries).some((e) => e.backend === "file")) body.note = FILE_NOTE;
    body.entries = this.entries;
    atomicWriteFileSync(secretsPath(), JSON.stringify(body, null, 2));
  }
}

// ── module-level store ─────────────────────────────────────────────────
// Lazy default so unit tests and library callers get a working file-backend
// store with zero setup; server boot calls initSecretStore() to attach the
// Electron broker (when main advertised it) and unseal keychain entries.
let current: SecretStore | null = null;

function detectBackend(): SecretBackend {
  const parentPort = (process as unknown as { parentPort?: BrokerPort }).parentPort;
  if (process.env.VELARIX_SAFE_STORAGE === "1" && parentPort) return createBrokerBackend(parentPort);
  return createFileBackend();
}

export function secretStore(): SecretStore {
  if (!current) current = new SecretStore(detectBackend());
  return current;
}

export async function initSecretStore(backend?: SecretBackend): Promise<SecretStore> {
  current = new SecretStore(backend ?? detectBackend());
  await current.unsealAll();
  return current;
}

export function resetSecretStoreForTests(): void {
  current = null;
}
