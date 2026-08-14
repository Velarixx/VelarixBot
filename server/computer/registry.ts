// Computer provider registry — config map → live providers, mirroring the
// driver registry's forward/backward-compatibility rule: an unknown kind or
// a config-decode/create failure becomes an UNAVAILABLE SHADOW PROVIDER
// (status: unconfigured with a reason; every operation rejects) instead of
// a boot failure.
//
// Defaults: `local` is CORE and always registered; `box` is bundled but
// OPTIONAL. An authored `computer.providers` map in ~/.velarixbot/config.json
// replaces the bundled default entirely — so dropping Box is config
// ({"computer":{"providers":{}}}), not surgery. Nothing here gates first
// run: an unconfigured provider is a reason string, never a prompt or a
// crash.
import type { AppConfig, ComputerProviderConfigMap } from "../config.ts";
import { BoxComputerProviderFactory } from "./box.ts";
import { FakeComputerProviderFactory } from "./fake.ts";
import { LocalComputerProviderFactory } from "./local.ts";
import {
  normalizeComputerBinding,
  type AnyComputerProviderFactory,
  type ComputerProvider,
  type ComputerStatus,
  type ExecuteEvent,
} from "./provider.ts";

export const BUILT_IN_COMPUTER_PROVIDERS: AnyComputerProviderFactory[] = [
  LocalComputerProviderFactory,
  BoxComputerProviderFactory,
  FakeComputerProviderFactory,
];

/** Resolve the provider map for this config. An authored `providers` object
 * (even an empty one) replaces the bundled default `{ box }`; `local` is
 * core and always present. */
export function computerProviderConfigs(cfg: AppConfig): ComputerProviderConfigMap {
  const authored = cfg.computer?.providers;
  const map: ComputerProviderConfigMap =
    authored && typeof authored === "object" && !Array.isArray(authored) ? { ...authored } : { box: { kind: "box" } };
  delete map.off; // reserved binding — never a provider id
  delete map.cloud; // reserved legacy alias
  if (!map.local) map.local = { kind: "local" };
  return map;
}

export interface ComputerRegistry {
  get(id: string): ComputerProvider | null;
  list(): ComputerProvider[];
  /** Canonical binding ("off" | provider id) or null when unresolvable. */
  resolveBinding(value: unknown): string | null;
  /** The provider backing the panel's cloud path / legacy "cloud" alias:
   * prefers the bundled `box` binding, else the first non-local provider. */
  defaultRemote(): ComputerProvider | null;
}

function shadowProvider(id: string, kind: string, reason: string): ComputerProvider {
  const fail = () => Promise.reject(new Error(reason));
  return {
    id,
    kind,
    displayName: kind,
    capabilities: { exec: false, screenshot: false, files: false, desktopUrl: false, suspend: false, destroy: false, mcp: false },
    turnPrompt: "",
    status: async (): Promise<ComputerStatus> => ({ configured: false, reason, machine: null }),
    provision: fail,
    // eslint-disable-next-line require-yield
    async *execute(): AsyncIterable<ExecuteEvent> {
      throw new Error(reason);
    },
    connectScreen: fail,
    suspend: fail,
    destroy: fail,
    screenshot: fail,
    readFile: fail,
    mcpIntegration: async () => null,
  };
}

export async function createComputerRegistry(opts: {
  cfg: AppConfig;
  factories?: AnyComputerProviderFactory[];
}): Promise<ComputerRegistry> {
  const factories = new Map((opts.factories ?? BUILT_IN_COMPUTER_PROVIDERS).map((f) => [f.kind, f]));
  const providers = new Map<string, ComputerProvider>();

  for (const [id, entry] of Object.entries(computerProviderConfigs(opts.cfg))) {
    const kind = typeof entry?.kind === "string" ? entry.kind : "";
    const factory = factories.get(kind);
    if (!factory) {
      providers.set(id, shadowProvider(id, kind || "unknown", `unknown computer provider kind "${kind}" — kept as configured, unavailable here`));
      continue;
    }
    try {
      const config = factory.decodeConfig(entry.config);
      providers.set(id, await factory.create({ id, config, appConfig: opts.cfg }));
    } catch (e) {
      providers.set(id, shadowProvider(id, kind, e instanceof Error ? e.message : String(e)));
    }
  }

  return {
    get: (id) => providers.get(id) ?? null,
    list: () => [...providers.values()],
    resolveBinding(value) {
      const binding = normalizeComputerBinding(value);
      if (binding === "off") return "off";
      return providers.has(binding) ? binding : null;
    },
    defaultRemote() {
      return providers.get("box") ?? [...providers.values()].find((p) => p.kind !== "local") ?? null;
    },
  };
}
