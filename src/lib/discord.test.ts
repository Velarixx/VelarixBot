import { describe, expect, it } from "vitest";
import {
  DISCORD_COPY,
  discordDisplayedStatus,
  isDiscordPublicStatus,
  type DiscordConfigStatus,
} from "./discord";

const connected: DiscordConfigStatus = {
  configured: true,
  enabled: true,
  guildAllowlist: ["1"],
  channelAllowlist: [],
  userAllowlist: [],
  bindings: [],
  status: "connected",
  statusMessage: DISCORD_COPY.connected,
  nextStep: "Authorized conversations stay on the bound agent.",
};

describe("discord displayed status", () => {
  it("surfaces an offline desktop runtime with a next step", () => {
    const shown = discordDisplayedStatus(connected, false);
    expect(shown.status).toBe("disconnected");
    expect(shown.statusMessage).toBe(DISCORD_COPY.offline);
    expect(shown.nextStep).toMatch(/Start the VelarixBot desktop app/i);
  });

  it("keeps the server status when the desktop runtime is connected", () => {
    const failed: DiscordConfigStatus = {
      ...connected,
      status: "error",
      statusMessage: "Discord error. Network. Check the bot token and Gateway connection, then reconnect.",
      nextStep: "Check the bot token, privileged Gateway intents, and network, then reconnect.",
    };
    expect(discordDisplayedStatus(failed, true)).toEqual({
      status: "error",
      statusMessage: failed.statusMessage,
      nextStep: failed.nextStep,
    });
    expect(discordDisplayedStatus(undefined, true).status).toBe("disconnected");
  });

  it("identifies the explicit public statuses", () => {
    expect(isDiscordPublicStatus("error")).toBe(true);
    expect(isDiscordPublicStatus("connected")).toBe(true);
    expect(isDiscordPublicStatus("connection_failed")).toBe(false);
  });
});
