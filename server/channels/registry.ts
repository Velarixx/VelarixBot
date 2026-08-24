// Channel connector registry — register by id, look up by id.
// Unknown kind or decode/create failure becomes an unavailable shadow
// connector instead of a boot failure (same rule as drivers / computers).
import {
  emptyRateLimit,
  unsupportedChannelOperation,
  type AnyChannelConnectorFactory,
  type ChannelAddress,
  type ChannelConnector,
  type ChannelConnectorStatus,
} from "./contracts.ts";
import { DiscordChannelFactory } from "./discord.ts";
import { FakeChannelFactory } from "./fake.ts";

export const BUILT_IN_CHANNEL_FACTORIES: AnyChannelConnectorFactory[] = [
  FakeChannelFactory,
  DiscordChannelFactory,
];

export interface ChannelRegistry {
  register(connector: ChannelConnector): void;
  get(id: string): ChannelConnector | null;
  list(): ChannelConnector[];
  statuses(): ChannelConnectorStatus[];
}

export interface ChannelRegistryEntry {
  kind: string;
  config?: unknown;
}

export function createChannelRegistrySync(connectors: ChannelConnector[] = []): ChannelRegistry {
  const byId = new Map<string, ChannelConnector>();
  for (const connector of connectors) byId.set(connector.id, connector);
  return {
    register(connector) {
      byId.set(connector.id, connector);
    },
    get(id) {
      return byId.get(id) ?? null;
    },
    list() {
      return [...byId.values()];
    },
    statuses() {
      return [...byId.values()].map((connector) => connector.status());
    },
  };
}

function shadowConnector(id: string, kind: string, reason: string): ChannelConnector {
  const fail = () => Promise.reject(new Error(reason));
  return {
    id,
    kind: kind || "unknown",
    displayName: kind || "unknown",
    capabilities: { send: false, receive: false, reactions: false, receipts: false },
    status() {
      return {
        id,
        kind: kind || "unknown",
        displayName: kind || "unknown",
        configured: false,
        enabled: false,
        status: "unavailable",
        statusMessage: reason,
      };
    },
    parseAddress(raw): ChannelAddress {
      const target = raw.trim();
      if (!target) throw new Error(reason);
      return { connectorId: id, kind: kind || "unknown", target };
    },
    formatAddress(address) {
      return `${address.kind}:${address.target}`;
    },
    send: fail,
    react: fail,
    retry: fail,
    rateLimit: () => emptyRateLimit(),
    onEvent() {
      return () => {};
    },
  };
}

/** Load connectors from an in-memory id → {kind,config} map. Empty by default. */
export async function createChannelRegistry(opts: {
  factories?: readonly AnyChannelConnectorFactory[];
  entries?: Record<string, ChannelRegistryEntry>;
} = {}): Promise<ChannelRegistry> {
  const factories = new Map((opts.factories ?? BUILT_IN_CHANNEL_FACTORIES).map((factory) => [factory.kind, factory]));
  const registry = createChannelRegistrySync();
  for (const [id, entry] of Object.entries(opts.entries ?? {})) {
    const kind = typeof entry?.kind === "string" ? entry.kind : "";
    const factory = factories.get(kind);
    if (!factory) {
      registry.register(shadowConnector(id, kind, `unknown channel connector kind "${kind}" — kept as configured, unavailable here`));
      continue;
    }
    try {
      const config = factory.decodeConfig(entry.config);
      registry.register(await factory.create({ id, config }));
    } catch (error) {
      registry.register(shadowConnector(id, kind, error instanceof Error ? error.message : String(error)));
    }
  }
  return registry;
}

export function channelUnsupported(kind: string, op: string): Error {
  return unsupportedChannelOperation(kind, op);
}
