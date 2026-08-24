/** Client-safe Discord integration types. Mirrors server/discord.ts —
 * do not import the server module from the client (it uses `.ts` extensions). */

export const DISCORD_PUBLIC_STATUSES = ["disconnected", "connected", "error"] as const;
export type DiscordPublicStatus = (typeof DISCORD_PUBLIC_STATUSES)[number];

export interface DiscordBinding {
  guildId?: string;
  channelId?: string;
  threadId?: string;
  botId?: string;
  groupId?: string;
}

export interface DiscordConfigStatus {
  configured: boolean;
  enabled: boolean;
  defaultBotId?: string;
  defaultGroupId?: string;
  guildAllowlist: string[];
  channelAllowlist: string[];
  userAllowlist: string[];
  bindings: DiscordBinding[];
  status: DiscordPublicStatus;
  statusMessage: string;
  nextStep: string;
}

export const DISCORD_COPY = {
  disconnected:
    "Discord is disconnected. Paste a bot token from the Discord Developer Portal, pick an agent or group, and add an allowlist to connect.",
  connected: "Discord is connected. Authorized guilds, channels, and users can message the bound agent.",
  offline:
    "VelarixBot is offline. Start the desktop app so Discord messages can be received and answered.",
  nextOffline: "Start the VelarixBot desktop app, then return here to connect Discord.",
  nextDisconnected: "Paste a Discord bot token, choose a binding, add an allowlist, then connect.",
};

export function isDiscordPublicStatus(value: unknown): value is DiscordPublicStatus {
  return typeof value === "string" && (DISCORD_PUBLIC_STATUSES as readonly string[]).includes(value);
}

/** Settings UI status: an unreachable desktop runtime wins over a live Gateway. */
export function discordDisplayedStatus(
  discord: DiscordConfigStatus | undefined,
  desktopConnected: boolean,
): { status: DiscordPublicStatus; statusMessage: string; nextStep: string } {
  if (!desktopConnected) {
    return { status: "disconnected", statusMessage: DISCORD_COPY.offline, nextStep: DISCORD_COPY.nextOffline };
  }
  if (!discord) {
    return {
      status: "disconnected",
      statusMessage: DISCORD_COPY.disconnected,
      nextStep: DISCORD_COPY.nextDisconnected,
    };
  }
  return { status: discord.status, statusMessage: discord.statusMessage, nextStep: discord.nextStep };
}
