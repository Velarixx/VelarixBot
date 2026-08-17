// Local computer provider — CORE, always registered, approval-gated. The
// user's own machine via the Electron-hosted cua-driver daemon: Electron
// main owns the daemon (macOS TCC attribution; Windows named pipe) and writes its MCP spawn
// contract to <userData>/cua-connection.json; the harness only reads that
// file and points the agent CLI at the already-running socket. No token,
// no vendor, no first-run dependency on anything cloud.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  unsupportedOperation,
  type ComputerMcpSpawn,
  type ComputerProvider,
  type ComputerProviderFactory,
  type ComputerStatus,
  type ExecuteEvent,
  type ProvisionResult,
  type ScreenConnection,
} from "./provider.ts";

const KIND = "local";

// Local computer-use contract written by Electron main on startup
// (app.getPath("userData")/cua-connection.json). Electron passes the exact
// location because that path is OS-specific. Read fresh each call.
function cuaConnectionCandidates(): string[] {
  if (process.env.OMB_USER_DATA) return [join(process.env.OMB_USER_DATA, "cua-connection.json")];
  const root =
    process.platform === "win32"
      ? (process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"))
      : process.platform === "darwin"
        ? join(homedir(), "Library", "Application Support")
        : (process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"));
  return ["VelarixBot", "velarixbot", "OpenMausBot", "openmausbot", "OpenGrokBot", "opengrokbot"].map((dir) =>
    join(root, dir, "cua-connection.json"),
  );
}

export function readCuaConnection(): ComputerMcpSpawn | null {
  for (const p of cuaConnectionCandidates()) {
    try {
      const conn = JSON.parse(readFileSync(p, "utf8"));
      if (!conn || conn.mode === "unavailable" || !conn.mcpCommand) continue;
      return { command: conn.mcpCommand, args: conn.mcpArgs ?? ["mcp"], env: conn.mcpEnv ?? {} };
    } catch {
      /* try the next location */
    }
  }
  return null;
}

export type LocalProviderConfig = Record<string, never>;

function decodeConfig(raw: unknown): LocalProviderConfig {
  if (raw !== undefined && (typeof raw !== "object" || raw === null || Array.isArray(raw))) {
    throw new Error("local computer provider: config must be an object");
  }
  return {};
}

export const LocalComputerProviderFactory: ComputerProviderFactory<LocalProviderConfig> = {
  kind: KIND,
  metadata: { displayName: "This computer" },
  decodeConfig,

  async create({ id }): Promise<ComputerProvider> {
    const provider: ComputerProvider = {
      id,
      kind: KIND,
      displayName: "This computer",
      capabilities: {
        // no server-side shell/capture on the user's machine — every action
        // goes through the approval-gated cua-driver MCP tools
        exec: false,
        screenshot: false,
        files: false,
        desktopUrl: false,
        suspend: false,
        destroy: false,
        mcp: true,
      },
      turnPrompt:
        "You can act on the user's computer through the computer tools — take a screenshot or read the desktop state first, prefer accessibility actions over raw coordinates, and act carefully.",

      async status(): Promise<ComputerStatus> {
        if (process.env.OMB_LOCAL_CUA_SUPPORTED === "0") {
          return { configured: false, reason: "local computer control is not available on this platform", machine: null };
        }
        const conn = readCuaConnection();
        if (!conn) {
          return {
            configured: false,
            reason: "the local computer daemon is not running — open the VelarixBot desktop app",
            machine: null,
          };
        }
        return { configured: true, machine: { id: "local", state: "ready" } };
      },

      async provision(): Promise<ProvisionResult> {
        const status = await provider.status("local");
        if (!status.configured) throw new Error(status.reason ?? "local computer is unavailable");
        return { machineId: "local", reused: true, state: "ready", joinUrl: null };
      },

      // eslint-disable-next-line require-yield
      async *execute(): AsyncIterable<ExecuteEvent> {
        throw unsupportedOperation(KIND, "execute");
      },

      async connectScreen(): Promise<ScreenConnection> {
        // the screen is this machine's own display — the desktop shell
        // captures frames; there is no URL to open
        return { kind: "local" };
      },

      async suspend() {
        throw unsupportedOperation(KIND, "suspend");
      },

      async destroy() {
        throw unsupportedOperation(KIND, "destroy");
      },

      async screenshot(): Promise<{ png: string; format: "png" | "jpeg" }> {
        throw unsupportedOperation(KIND, "screenshot");
      },

      async readFile(): Promise<{ content: string; path: string }> {
        throw unsupportedOperation(KIND, "readFile");
      },

      async mcpIntegration(): Promise<ComputerMcpSpawn | null> {
        return readCuaConnection();
      },
    };
    return provider;
  },
};
