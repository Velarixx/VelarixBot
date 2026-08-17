// Box computer provider — the bundled (but OPTIONAL) cloud computer,
// adapting the Box vendor client in server/box.ts to the ComputerProvider
// SPI. Removable via config: an authored computer.providers map without a
// box entry means no Box anywhere — no token prompt, no vendor URL, local
// mode untouched. The vendor URL never leaves this provider: the MCP proxy
// spawn contract carries it as OGB_BOX_URL, so drivers and the proxy stay
// vendor-blind.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { appendAudit } from "../approvals.ts";
import * as box from "../box.ts";
import type { AppConfig } from "../config.ts";
import {
  assertAbsolutePath,
  unsupportedOperation,
  type ComputerMcpSpawn,
  type ComputerProvider,
  type ComputerProviderFactory,
  type ComputerStatus,
  type ExecuteEvent,
  type ProvisionResult,
  type ScreenConnection,
} from "./provider.ts";

const KIND = "box";

// 2026-08-17 [VERIFY] capabilities/destroy: this provider declares
// suspend:true, mcp:true, destroy:false — destroy rejects with the
// canonical unsupported error and is exposed on NO route (the panel offers
// provision|join|sleep|exec|screenshot only), so shared mode adds no
// destroy surface to guard. The migration cleanup below is the one
// deliberate delete path, scoped to stranded per-bot boxes and never the
// shared machine.

/** Migration cleanup (3.8) — a provider-internal extension the composition
 * root hands to the computer routes. NOT part of the ComputerProvider SPI:
 * sharing (and cleaning up after it) is a box concern. */
export interface BoxMaintenance {
  list(): Promise<Array<{ id: string; name: string; state: string | null }>>;
  destroy(ids: string[]): Promise<{ destroyed: Array<{ id: string; name: string }>; failed: Array<{ id: string; error: string }> }>;
}

const MAINTENANCE = new WeakMap<ComputerProvider, BoxMaintenance>();

export function boxMaintenance(provider: ComputerProvider | null | undefined): BoxMaintenance | null {
  return provider ? MAINTENANCE.get(provider) ?? null : null;
}

// the proxy entry lives next to server/ as .ts in dev and .js in the
// compiled dist-server the packaged app ships
function computerProxyPath(): string {
  const ts = join(dirname(fileURLToPath(import.meta.url)), "..", "computer-proxy.ts");
  return existsSync(ts) ? ts : ts.replace(/\.ts$/, ".js");
}

export interface BoxProviderConfig {
  /** Override the Box API base (tests, self-hosted gateway). */
  url?: string;
}

function decodeConfig(raw: unknown): BoxProviderConfig {
  const o = (raw ?? {}) as Record<string, unknown>;
  if (o.url !== undefined && (typeof o.url !== "string" || !o.url.trim())) {
    throw new Error("box computer provider: url must be a non-empty string");
  }
  return { ...(typeof o.url === "string" ? { url: o.url.replace(/\/$/, "") } : {}) };
}

export const BoxComputerProviderFactory: ComputerProviderFactory<BoxProviderConfig> = {
  kind: KIND,
  metadata: { displayName: "Cloud box" },
  decodeConfig,

  async create({ id, config, appConfig }): Promise<ComputerProvider> {
    // Strict decode of the shared-box knobs (cfg.box.shared / namePrefix /
    // leaseWaitMs): an invalid type rejects create, and the registry
    // downgrades this provider to an unavailable shadow — a bad config value
    // must never crash boot.
    box.decodeBoxSharing(appConfig);

    // Effective vendor config for the box client: the write-only token and
    // the shared-box knobs always come from the LIVE app config (the
    // composition root mutates it in place on save, so a Settings toggle
    // applies to the next operation without a restart); the URL can be
    // pinned per provider instance.
    const boxCfg = (): AppConfig => ({
      box: { ...appConfig.box, url: config.url ?? appConfig.box?.url },
    });
    const token = () => appConfig.box?.token;

    // Shared box = shared trust domain: any bot can read any path and the
    // one Chrome's logins are common property (D1/D2). Exec, file reads,
    // and desktop joins on the shared machine therefore land in the
    // append-only audit log with machine:"shared"; per-bot mode stays
    // audit-silent, exactly as before.
    const auditShared = (botId: string, tool: string, decision: string, matcher: string) => {
      if (!box.decodeBoxSharing(boxCfg()).shared) return;
      appendAudit({ bot: botId, tool, matcher, decision, machine: "shared" });
    };

    const provider: ComputerProvider = {
      id,
      kind: KIND,
      displayName: "Cloud box",
      capabilities: {
        exec: true,
        screenshot: true,
        files: true,
        desktopUrl: true,
        suspend: true,
        // the box is the bot's persistent computer — sleep pauses billing,
        // the disk survives; the vendor client has no delete surface
        destroy: false,
        mcp: true,
      },
      turnPrompt:
        "You have your own cloud computer — use the computer tools (screenshot, computer_exec, open_url) whenever browsing or acting on a desktop helps.",

      async status(botId): Promise<ComputerStatus> {
        if (!token()) {
          return {
            configured: false,
            reason: 'no Box token — add {"box":{"token":"…"}} to ~/.velarixbot/config.json',
            machine: null,
          };
        }
        try {
          const b = await box.findBox(boxCfg(), botId);
          return {
            configured: true,
            machine: b ? { id: b.id, state: b.state, desktopAvailable: b.desktopAvailable ?? null } : null,
          };
        } catch (e) {
          return {
            configured: true,
            reason: `box API unreachable: ${e instanceof Error ? e.message : String(e)}`,
            machine: null,
          };
        }
      },

      async provision(bot): Promise<ProvisionResult> {
        const r = await box.provisionBox(boxCfg(), bot.id, bot.name);
        return {
          machineId: r.boxId,
          machineName: r.machineName,
          reused: r.reused,
          state: r.state ?? null,
          joinUrl: r.joinUrl ?? null,
        };
      },

      async *execute(botId, command): AsyncIterable<ExecuteEvent> {
        auditShared(botId, "computer_exec", "computer.exec", String(command ?? ""));
        // the Box run-command endpoint is synchronous — the stream settles
        // in one round trip
        const out = await box.execOnBox(boxCfg(), botId, command);
        if (out.stdout) yield { type: "stdout", data: out.stdout };
        if (out.stderr) yield { type: "stderr", data: out.stderr };
        yield { type: "exit", exitCode: out.exitCode };
      },

      async connectScreen(botId): Promise<ScreenConnection> {
        auditShared(botId, "computer_join", "computer.join", box.sharedBoxName(boxCfg()));
        const r = await box.joinBox(boxCfg(), botId);
        if (!r.joinUrl) throw new Error("the box did not mint a desktop URL — try again");
        return { kind: "url", url: r.joinUrl, state: r.state ?? null };
      },

      async suspend(botId) {
        await box.sleepBox(boxCfg(), botId);
      },

      async destroy() {
        throw unsupportedOperation(KIND, "destroy");
      },

      async screenshot(botId) {
        const r = await box.screenshotBox(boxCfg(), botId);
        return { png: r.png, format: "png" };
      },

      async readFile(botId, path) {
        assertAbsolutePath(path);
        auditShared(botId, "computer_read_file", "computer.read", path);
        return box.readBoxPath(boxCfg(), botId, path);
      },

      async mcpIntegration(botId, opts): Promise<ComputerMcpSpawn | null> {
        const t = token();
        if (!t) return null;
        const machineId = opts?.machineId ?? (await box.findBox(boxCfg(), botId).catch(() => null))?.id;
        if (!machineId) return null;
        return {
          command: process.execPath,
          args: [computerProxyPath()],
          env: {
            // packaged app: process.execPath is Electron — run the proxy as node
            ELECTRON_RUN_AS_NODE: "1",
            OGB_BOX_URL: box.boxApiBase(boxCfg()),
            OGB_BOX_ID: machineId,
            OGB_BOX_TOKEN: t,
            // 2026-08-17 [VERIFY]: the computer-proxy MCP hits the Box REST
            // commands endpoint DIRECTLY (computer-proxy.ts runOnBox), never
            // execOnBox — so the shared-mode per-bot cwd must ride the spawn
            // contract and be re-applied by the proxy's computer_exec tool.
            ...(box.decodeBoxSharing(boxCfg()).shared ? { OGB_BOX_CWD: box.botBoxCwd(botId) } : {}),
          },
        };
      },
    };
    MAINTENANCE.set(provider, {
      async list() {
        if (!token()) throw new Error("box provider not enabled — add a Box token first");
        return box.listStaleBotBoxes(boxCfg());
      },
      async destroy(ids) {
        if (!token()) throw new Error("box provider not enabled — add a Box token first");
        return box.destroyStaleBotBoxes(boxCfg(), ids);
      },
    });
    return provider;
  },
};
