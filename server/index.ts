// VelarixBot server entry — environment, persistence boot, and the HTTP
// listener. Clients hold no transports (upstream rule): the React app
// dispatches typed commands over HTTP and folds one SSE event stream; every
// provider process runs here. Everything else is wired by the composition
// root in app.ts (createApplication), so the application is constructible
// in tests with fake repos/providers/clock.
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";

import { createApplication } from "./app.ts";
import { quarantineLegacyRules } from "./approvals.ts";
import { resolveApiToken, resolveApplicationAuthMode, resolveSaasApplicationOrigin } from "./auth.ts";
import { ensureDirs, instanceConfigs, loadConfig, migrateConfigSecrets } from "./config.ts";
import { openDefaultDatabase } from "./db/database.ts";
import { importLegacyData } from "./db/importer.ts";
import { BUILT_IN_DRIVERS } from "./drivers/builtIn.ts";
import { EventBus } from "./harness/bus.ts";
import { ProviderRegistry } from "./harness/registry.ts";
import { attachListenError } from "./listen-error.ts";
import { createGithubOAuthProvider, resolveGithubOAuthConfiguration } from "./oauth/github-provider.ts";
import { createRepositories } from "./repositories/index.ts";
import { initSecretStore } from "./secrets.ts";

const PORT = Number(process.env.OMB_PORT || process.env.OGB_PORT || 8799);
const STATIC_DIR = process.env.OMB_STATIC_DIR || null;

// Last-resort crash guards: a misbehaving third-party CLI must never take
// the whole server down. Async stream errors that escape their owners (the
// rc.12 field crash was a `write EPIPE` on a dead child's stdin) land here —
// log and keep serving; every turn-level failure path settles itself.
process.on("uncaughtException", (e) => {
  console.error("[server] uncaught exception (continuing):", e);
});
process.on("unhandledRejection", (e) => {
  console.error("[server] unhandled rejection (continuing):", e);
});

ensureDirs();
// SecretStore first (Electron-main safeStorage broker when forked packaged,
// the documented file fallback when headless), then the idempotent plaintext
// → secret:// migration for a pre-P1.5 config.json — both before loadConfig.
await initSecretStore();
await migrateConfigSecrets();
// Consent-bug migration: legacy workspace-wide / wildcard Allow rules are
// parked (disabled) until reconfirmed in Settings. Idempotent on every boot.
quarantineLegacyRules();
const cfg = loadConfig();
const registry = new ProviderRegistry(BUILT_IN_DRIVERS);
await registry.load(instanceConfigs(cfg));

const bus = new EventBus();
bus.attach(registry.instances());

// ── persistence boot ───────────────────────────────────────────────────
// One SQLite store (~/.velarixbot/velarixbot.db): open + migrate, then the
// rerunnable legacy-JSON import (backup first, checksum-verified, originals
// untouched) and the every-boot snapshot refresh for the file-authoritative
// domains (approvals / skills / memory).
const db = openDefaultDatabase();
const repos = createRepositories(db);
importLegacyData(repos);

// ── tokens ─────────────────────────────────────────────────────────────
// A shared secret guards the localhost-only /api/internal endpoints the
// agents-proxy and memory-proxy call; regenerated each boot (the proxy
// gets it via env).
const COMMS_TOKEN = process.env.OMB_COMMS_TOKEN || randomBytes(24).toString("hex");
// Per-launch capability for the public /api surface (separate from
// COMMS_TOKEN): Electron main mints it and injects it on every renderer
// request; dev sets VELARIX_DEV_TOKEN. Without either, the minted token is
// never shared — fail closed, never silent-off. /api/health stays open.
const API_TOKEN = resolveApiToken();
const AUTH_MODE = resolveApplicationAuthMode();
const AUTH = (() => {
  if (AUTH_MODE === "desktop") return { mode: "desktop" } as const;
  const applicationOrigin = resolveSaasApplicationOrigin();
  const oauthConfig = resolveGithubOAuthConfiguration(applicationOrigin);
  return {
    mode: "saas",
    applicationOrigin,
    oauthProvider: createGithubOAuthProvider(oauthConfig),
  } as const;
})();

/** Rebuild the provider fleet after a config change so new keys take
 * effect without a server restart (kills any in-flight turns). */
async function reloadProviders() {
  bus.detachAll();
  await registry.disposeAll();
  await registry.load(instanceConfigs(cfg));
  bus.attach(registry.instances());
}

const app = await createApplication({
  repos,
  providers: registry,
  bus,
  cfg,
  clock: { now: () => Date.now() },
  port: PORT,
  apiToken: API_TOKEN,
  auth: AUTH,
  commsToken: COMMS_TOKEN,
  staticDir: STATIC_DIR,
  // release-smoke identity: the stamp names live code paths
  // (ensureBotWorkspace in turn dispatch, mcpOverlay in the codex driver)
  stamp: "ensureBotWorkspace+mcpOverlay",
  reloadProviders,
});

setTimeout(() => app.tick(), 25).unref?.();
setInterval(() => app.tick(), 15_000).unref?.();

const server = createServer((req, res) => {
  void app.handle(req, res);
});
attachListenError(server);
server.listen(PORT, "127.0.0.1", () => {
  console.log(`velarixbot server on http://127.0.0.1:${PORT}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void registry.disposeAll().finally(() => {
      try {
        db.close();
      } catch {
        /* already closed */
      }
      process.exit(0);
    });
  });
}
