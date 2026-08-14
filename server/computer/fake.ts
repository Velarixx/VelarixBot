// Fake computer provider — in-memory, deterministic, zero I/O. Two jobs:
// power the conformance suite every provider must pass, and let app-level
// tests exercise the whole computer surface (panel routes, turn attach,
// screen-in-chat) without a vendor or a network. Bindable from config like
// any provider: {"computer":{"providers":{"fake":{"kind":"fake"}}}}.
import {
  assertAbsolutePath,
  type ComputerMcpSpawn,
  type ComputerProvider,
  type ComputerProviderFactory,
  type ComputerStatus,
  type ExecuteEvent,
  type ProvisionResult,
  type ScreenConnection,
} from "./provider.ts";

const KIND = "fake";

// 1x1 transparent PNG — a real decodable frame for screen-in-chat paths
export const FAKE_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

interface FakeMachine {
  id: string;
  state: "running" | "archived";
  commands: string[];
}

export type FakeProviderConfig = Record<string, never>;

function decodeConfig(raw: unknown): FakeProviderConfig {
  if (raw !== undefined && (typeof raw !== "object" || raw === null || Array.isArray(raw))) {
    throw new Error("fake computer provider: config must be an object");
  }
  return {};
}

export const FakeComputerProviderFactory: ComputerProviderFactory<FakeProviderConfig> = {
  kind: KIND,
  metadata: { displayName: "Fake computer" },
  decodeConfig,

  async create({ id }): Promise<ComputerProvider> {
    const machines = new Map<string, FakeMachine>();
    const machineFor = (botId: string): FakeMachine => {
      const m = machines.get(botId);
      if (!m) throw new Error("no computer for this bot yet — provision it first");
      return m;
    };

    const provider: ComputerProvider = {
      id,
      kind: KIND,
      displayName: "Fake computer",
      capabilities: {
        exec: true,
        screenshot: true,
        files: true,
        desktopUrl: true,
        suspend: true,
        destroy: true,
        mcp: true,
      },
      turnPrompt: "You have a fake computer for testing — its tools echo instead of acting.",

      async status(botId): Promise<ComputerStatus> {
        const m = machines.get(botId);
        return {
          configured: true,
          machine: m ? { id: m.id, state: m.state, desktopAvailable: m.state === "running" } : null,
        };
      },

      async provision(bot): Promise<ProvisionResult> {
        const existing = machines.get(bot.id);
        if (existing) {
          existing.state = "running";
          return { machineId: existing.id, reused: true, state: "running", joinUrl: `fake://desktop/${existing.id}` };
        }
        const machine: FakeMachine = { id: `fake-${bot.id}`, state: "running", commands: [] };
        machines.set(bot.id, machine);
        return { machineId: machine.id, machineName: bot.name, reused: false, state: "running", joinUrl: `fake://desktop/${machine.id}` };
      },

      async *execute(botId, command): AsyncIterable<ExecuteEvent> {
        const m = machineFor(botId);
        m.commands.push(command);
        yield { type: "stdout", data: `fake:${command}\n` };
        yield { type: "exit", exitCode: 0 };
      },

      async connectScreen(botId): Promise<ScreenConnection> {
        const m = machineFor(botId);
        m.state = "running";
        return { kind: "url", url: `fake://desktop/${m.id}`, state: m.state };
      },

      async suspend(botId) {
        machineFor(botId).state = "archived";
      },

      async destroy(botId) {
        machineFor(botId);
        machines.delete(botId);
      },

      async screenshot(botId) {
        const m = machineFor(botId);
        if (m.state !== "running") throw new Error(`computer is ${m.state}`);
        return { png: FAKE_PNG, format: "png" as const };
      },

      async readFile(botId, path) {
        machineFor(botId);
        assertAbsolutePath(path);
        return { content: Buffer.from(`fake file at ${path}`).toString("base64"), path };
      },

      async mcpIntegration(botId): Promise<ComputerMcpSpawn | null> {
        const m = machines.get(botId);
        if (!m) return null;
        return { command: process.execPath, args: ["-e", "process.stdin.resume()"], env: { OMB_FAKE_COMPUTER_ID: m.id } };
      },
    };
    return provider;
  },
};
