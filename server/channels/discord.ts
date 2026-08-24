// Discord connector types + unavailable stub.
//
// Priority 1 ships the VelarixBot-native shapes and a factory that
// never opens a Gateway, REST session, or any network to Discord.
// Live Discord is a later priority. decodeConfig throws if a caller
// tries to enable a live connection in this build.
import {
  emptyRateLimit,
  initialRetry,
  unsupportedChannelOperation,
  type ChannelAddress,
  type ChannelConnector,
  type ChannelConnectorFactory,
  type ChannelDeliveryReceipt,
  type ChannelIdentity,
} from "./contracts.ts";

export const DISCORD_CHANNEL_KIND = "discord";

export interface DiscordChannelConfig {
  /** Reserved. A live token is rejected — Gateway is not in this build. */
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function decodeDiscordChannelConfig(raw: unknown): DiscordChannelConfig {
  if (raw === undefined) return {};
  if (!isRecord(raw)) throw new Error("discord channel: config must be an object");
  // Any attempt to supply connection material is invalid this PR.
  for (const key of ["token", "botToken", "gateway", "restUrl", "appId", "applicationId"]) {
    const value = raw[key];
    if (typeof value === "string" && value.trim()) {
      throw new Error("discord channel: live Gateway is not available in this build");
    }
  }
  return {};
}

export function parseDiscordAddress(raw: string, connectorId: string): ChannelAddress {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("discord channel: address must be non-empty");
  let target = trimmed;
  if (trimmed.startsWith("discord://")) target = trimmed.slice("discord://".length);
  else if (trimmed.startsWith("discord:")) target = trimmed.slice("discord:".length);
  else if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
    throw new Error(`discord channel: unsupported address scheme in "${trimmed}"`);
  }
  target = target.replace(/^\/+/, "").trim();
  if (!target || /\s/.test(target)) throw new Error("discord channel: address target must be a single token");
  return { connectorId, kind: DISCORD_CHANNEL_KIND, target, display: `discord:${target}` };
}

export function formatDiscordAddress(address: ChannelAddress): string {
  if (address.kind !== DISCORD_CHANNEL_KIND) {
    throw new Error(`discord channel: cannot format a ${address.kind} address`);
  }
  if (!address.target.trim()) throw new Error("discord channel: address target must be non-empty");
  return `discord:${address.target.trim()}`;
}

export function createDiscordStubConnector(id: string): ChannelConnector {
  const reason = "Discord Gateway is not implemented in this build.";
  const unavailable = () => Promise.reject(unsupportedChannelOperation(DISCORD_CHANNEL_KIND, "live transport"));

  return {
    id,
    kind: DISCORD_CHANNEL_KIND,
    displayName: "Discord",
    capabilities: { send: false, receive: false, reactions: false, receipts: false },
    status() {
      return {
        id,
        kind: DISCORD_CHANNEL_KIND,
        displayName: "Discord",
        configured: false,
        enabled: false,
        status: "unavailable",
        statusMessage: reason,
      };
    },
    parseAddress(raw) {
      return parseDiscordAddress(raw, id);
    },
    formatAddress: formatDiscordAddress,
    send: unavailable,
    react: unavailable,
    retry: unavailable,
    rateLimit: () => emptyRateLimit(),
    onEvent() {
      return () => {};
    },
  };
}

export const DiscordChannelFactory: ChannelConnectorFactory<DiscordChannelConfig> = {
  kind: DISCORD_CHANNEL_KIND,
  metadata: { displayName: "Discord" },
  decodeConfig: decodeDiscordChannelConfig,
  async create({ id }) {
    return createDiscordStubConnector(id);
  },
};

// Keep identity/receipt type names imported so Discord-shaped values stay
// in this module's public surface without a live mapping implementation.
export type DiscordSenderIdentity = ChannelIdentity;
export type DiscordDeliveryReceipt = ChannelDeliveryReceipt;
export type DiscordRetryState = ReturnType<typeof initialRetry>;
