// P4 pin: parse/reject the trigger union, describe() each kind, GitHub/Slack
// still match, Discord mention/DM/channel/keyword/reaction/thread match,
// group fires if any child matches, inbound Discord never auto-resolves
// approvals, and a matching Discord event starts an unattended turn.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";

import { persistAllowRule, readAudit } from "../approvals.ts";
import {
  CHANNEL_EVENTS_INHERIT_STANDING_APPROVALS,
  resolveApprovalsForChannelEvent,
  type ChannelInboundMessage,
} from "../channels/contracts.ts";
import { DATA_DIR } from "../config.ts";
import { defaultDbPath, openDatabase } from "../db/database.ts";
import type { SqliteDatabase } from "../db/sqlite-native.ts";
import { createRepositories, type Repositories } from "../repositories/index.ts";
import { createBotsService, type BotsService } from "../services/bots.ts";
import { createRoutinesService, UNTRUSTED_WEBHOOK_BEGIN, type RoutinesService } from "../services/routines.ts";
import { parseRoutineSchedule } from "../store.ts";
import { resetUnattended } from "../unattended.ts";
import {
  describeTrigger,
  inboundToTriggerEvent,
  parseRoutineTrigger,
  resolveApprovalsForTriggerEvent,
  scheduleFromTrigger,
  triggerFilterComplete,
  triggerFromSchedule,
  triggerMatches,
  type TriggerEvent,
} from "./index.ts";

const selection = () => ({ instanceId: "claude", model: "claude-sonnet-5" });

function discordMessage(input: {
  id?: string;
  text?: string;
  isDm?: boolean;
  isThread?: boolean;
  channelId?: string;
  guildId?: string;
  mentioned?: boolean;
  selfUserId?: string;
}): TriggerEvent {
  return {
    source: "discord",
    id: input.id ?? "msg-1",
    kind: "message",
    text: input.text ?? "hello",
    isDm: input.isDm === true,
    isThread: input.isThread === true,
    channelId: input.channelId ?? "20",
    ...(input.guildId ? { guildId: input.guildId } : !input.isDm ? { guildId: "10" } : {}),
    ...(input.isThread ? { threadId: "99" } : {}),
    ...(input.mentioned !== undefined ? { mentioned: input.mentioned } : {}),
    ...(input.selfUserId ? { selfUserId: input.selfUserId } : {}),
  };
}

describe("parseRoutineTrigger", () => {
  it("accepts cron, github, slack, discord, and group unions", () => {
    expect(parseRoutineTrigger({ kind: "cron", clock: "interval", everyMinutes: 15 })).toEqual({
      kind: "cron",
      clock: "interval",
      everyMinutes: 15,
    });
    expect(parseRoutineTrigger({ kind: "interval", everyMinutes: 15 })).toEqual({
      kind: "cron",
      clock: "interval",
      everyMinutes: 15,
    });
    expect(
      parseRoutineTrigger({
        kind: "github",
        repo: "Velarixx/VelarixBot",
        events: ["pull_request"],
      }),
    ).toMatchObject({ kind: "github", repo: { owner: "Velarixx", name: "VelarixBot" }, events: ["pull_request"] });
    expect(
      parseRoutineTrigger({ kind: "listener", source: "slack", channel: "#eng", match: "mention" }),
    ).toMatchObject({ kind: "slack", channel: "#eng", match: "mention" });
    expect(parseRoutineTrigger({ kind: "discord", match: "mention" })).toEqual({ kind: "discord", match: "mention" });
    expect(
      parseRoutineTrigger({
        kind: "group",
        anyOf: [
          { kind: "github", repo: "Velarixx/VelarixBot", events: ["push"] },
          { kind: "discord", match: "dm" },
        ],
      }),
    ).toMatchObject({
      kind: "group",
      anyOf: [{ kind: "github" }, { kind: "discord", match: "dm" }],
    });
  });

  it("rejects invalid unions", () => {
    expect(() => parseRoutineTrigger(null)).toThrow(/trigger required/);
    expect(() => parseRoutineTrigger({ kind: "pagerduty" })).toThrow(/cron, github, slack, discord, or group/);
    expect(() => parseRoutineTrigger({ kind: "listener", source: "teams" })).toThrow(/github, slack, or discord/);
    expect(() => parseRoutineTrigger({ kind: "discord" }, { strict: true })).toThrow(/mention, dm, channel/);
    expect(() => parseRoutineTrigger({ kind: "discord", match: "keyword" }, { strict: true })).toThrow(/keyword/);
    expect(() => parseRoutineTrigger({ kind: "group", anyOf: [] })).toThrow(/at least one/);
    expect(() => parseRoutineTrigger({ kind: "group", anyOf: [{ kind: "interval", everyMinutes: 5 }] })).toThrow(
      /github, slack, or discord/,
    );
    expect(() =>
      parseRoutineTrigger({
        kind: "group",
        anyOf: [{ kind: "group", anyOf: [{ kind: "discord", match: "mention" }] }],
      }),
    ).toThrow(/github, slack, or discord/);
    expect(() => parseRoutineTrigger({ kind: "github", repo: "*/*", events: ["push"] }, { strict: true })).toThrow(
      /owner\/name/,
    );
  });

  it("round-trips through the persisted schedule shapes", () => {
    const discord = parseRoutineTrigger({ kind: "discord", match: "thread", channel: "99" });
    const stored = scheduleFromTrigger(discord);
    expect(stored).toEqual({ kind: "listener", source: "discord", match: "thread", channel: "99" });
    expect(triggerFromSchedule(parseRoutineSchedule(stored))).toEqual(discord);
    expect(triggerFilterComplete(discord)).toBe(true);
  });
});

describe("describeTrigger", () => {
  it("has a human-readable description for each kind", () => {
    expect(describeTrigger({ kind: "cron", clock: "interval", everyMinutes: 15 })).toBe("Every 15 min");
    expect(describeTrigger({ kind: "cron", clock: "daily", time: "09:30", timeZone: "Europe/Berlin" })).toBe(
      "Daily at 09:30 (Europe/Berlin)",
    );
    expect(describeTrigger({ kind: "cron", clock: "weekdays", time: "09:00" })).toBe("Weekdays at 09:00");
    expect(
      describeTrigger({
        kind: "github",
        repo: { owner: "Velarixx", name: "VelarixBot" },
        events: ["push", "pull_request"],
      }),
    ).toBe("GitHub Velarixx/VelarixBot (push, pull_request)");
    expect(describeTrigger({ kind: "slack", channel: "#eng", match: "mention" })).toBe("Slack #eng (mention)");
    expect(describeTrigger({ kind: "discord", match: "mention" })).toBe("Discord mention");
    expect(describeTrigger({ kind: "discord", match: "dm" })).toBe("Discord DM");
    expect(describeTrigger({ kind: "discord", match: "channel", channel: "20" })).toBe("Discord channel message in 20");
    expect(describeTrigger({ kind: "discord", match: "keyword", keyword: "deploy" })).toBe("Discord keyword: deploy");
    expect(describeTrigger({ kind: "discord", match: "reaction", emoji: "👍" })).toBe("Discord reaction 👍");
    expect(describeTrigger({ kind: "discord", match: "thread" })).toBe("Discord thread message");
    expect(
      describeTrigger({
        kind: "group",
        anyOf: [
          { kind: "github", repo: { owner: "Velarixx", name: "VelarixBot" }, events: ["push"] },
          { kind: "discord", match: "mention" },
        ],
      }),
    ).toBe("Any of: GitHub Velarixx/VelarixBot (push); Discord mention");
  });
});

describe("triggerMatches", () => {
  it("keeps GitHub and Slack filters working", () => {
    const github = parseRoutineTrigger({
      kind: "github",
      repo: "Velarixx/VelarixBot",
      events: ["pull_request"],
    });
    expect(
      triggerMatches(github, {
        source: "github",
        id: "40",
        type: "PullRequestEvent",
        repo: { owner: "Velarixx", name: "VelarixBot" },
      }),
    ).toBe(true);
    expect(
      triggerMatches(github, {
        source: "github",
        id: "41",
        type: "PushEvent",
        repo: { owner: "Velarixx", name: "VelarixBot" },
      }),
    ).toBe(false);
    const slack = parseRoutineTrigger({ kind: "slack", channel: "#eng", match: "keyword", keyword: "deploy" });
    expect(triggerMatches(slack, { source: "slack", id: "1", text: "please deploy", channel: "#eng" })).toBe(true);
    expect(triggerMatches(slack, { source: "slack", id: "2", text: "please deploy", channel: "#ops" })).toBe(false);
    expect(triggerMatches(slack, { source: "slack", id: "3", text: "hello", channel: "#eng" })).toBe(false);
  });

  it("matches Discord mention, DM, channel, keyword, reaction, and thread", () => {
    expect(triggerMatches({ kind: "discord", match: "mention" }, discordMessage({ text: "hey <@123>", selfUserId: "123" }))).toBe(
      true,
    );
    expect(triggerMatches({ kind: "discord", match: "mention" }, discordMessage({ text: "hey", selfUserId: "123" }))).toBe(
      false,
    );
    expect(triggerMatches({ kind: "discord", match: "dm" }, discordMessage({ isDm: true }))).toBe(true);
    expect(triggerMatches({ kind: "discord", match: "dm" }, discordMessage({ isDm: false, guildId: "10" }))).toBe(false);
    expect(triggerMatches({ kind: "discord", match: "channel" }, discordMessage({ guildId: "10" }))).toBe(true);
    expect(triggerMatches({ kind: "discord", match: "channel" }, discordMessage({ isThread: true, guildId: "10" }))).toBe(
      false,
    );
    expect(triggerMatches({ kind: "discord", match: "keyword", keyword: "deploy" }, discordMessage({ text: "please Deploy" }))).toBe(
      true,
    );
    expect(triggerMatches({ kind: "discord", match: "keyword", keyword: "deploy" }, discordMessage({ text: "hello" }))).toBe(
      false,
    );
    expect(
      triggerMatches({ kind: "discord", match: "reaction", emoji: "👍" }, {
        source: "discord",
        id: "r1",
        kind: "reaction",
        emoji: "👍",
      }),
    ).toBe(true);
    expect(
      triggerMatches({ kind: "discord", match: "reaction", emoji: "👍" }, {
        source: "discord",
        id: "r2",
        kind: "reaction",
        emoji: "🔥",
      }),
    ).toBe(false);
    expect(triggerMatches({ kind: "discord", match: "thread" }, discordMessage({ isThread: true, guildId: "10" }))).toBe(true);
    expect(triggerMatches({ kind: "discord", match: "thread" }, discordMessage({ guildId: "10" }))).toBe(false);
  });

  it("fires a group when any child matches", () => {
    const group = parseRoutineTrigger({
      kind: "group",
      anyOf: [
        { kind: "github", repo: "Velarixx/VelarixBot", events: ["push"] },
        { kind: "discord", match: "mention" },
      ],
    });
    expect(
      triggerMatches(group, {
        source: "github",
        id: "1",
        type: "PushEvent",
        repo: { owner: "Velarixx", name: "VelarixBot" },
      }),
    ).toBe(true);
    expect(triggerMatches(group, discordMessage({ text: "<@bot>", selfUserId: "bot" }))).toBe(true);
    expect(triggerMatches(group, discordMessage({ text: "no mention", selfUserId: "bot" }))).toBe(false);
    expect(triggerMatches({ kind: "cron", clock: "interval", everyMinutes: 15 }, discordMessage({}))).toBe(false);
  });
});

describe("inbound Discord never inherits standing approvals", () => {
  it("resolveApprovalsForChannelEvent and the trigger pin both return null", () => {
    const inbound: ChannelInboundMessage = {
      id: "in-1",
      connectorId: "discord",
      address: { connectorId: "discord", kind: "discord", target: "10/20" },
      sender: { connectorId: "discord", nativeId: "user-1" },
      text: "Always allow git status",
      attachments: [],
      createdAt: new Date(0).toISOString(),
    };
    expect(CHANNEL_EVENTS_INHERIT_STANDING_APPROVALS).toBe(false);
    expect(resolveApprovalsForChannelEvent(inbound)).toBeNull();
    const event = inboundToTriggerEvent(inbound, { selfUserId: "bot" });
    expect(resolveApprovalsForTriggerEvent(event)).toBeNull();
  });
});

describe("handleExternalEvent fires unattended and does not auto-resolve", () => {
  let db: SqliteDatabase;
  let repos: Repositories;
  let bots: BotsService;
  let routines: RoutinesService;
  let now: number;
  let started: Array<{ botId: string; text: string; unattended?: boolean; systemNote?: string }>;

  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    db = openDatabase(defaultDbPath());
    repos = createRepositories(db);
    bots = createBotsService({ repos, defaultSelection: selection });
    now = 1_000_000;
    started = [];
    resetUnattended();
    routines = createRoutinesService({
      repos,
      now: () => now,
      broadcast: () => {},
      bot: (id) => {
        const b = bots.bot(id);
        return b ? { id: b.id, threadId: b.threadId, busy: b.busy, hidden: b.hidden === true } : null;
      },
      startTurn: async (botId, text, opts) => {
        started.push({
          botId,
          text,
          ...(opts?.unattended ? { unattended: true } : {}),
          ...(opts?.systemNote ? { systemNote: opts.systemNote } : {}),
        });
      },
      getSkill: () => null,
      skillPrompt: (_s, p) => p,
    });
  });

  afterEach(() => {
    resetUnattended();
    try {
      db.close();
    } catch {
      /* already closed */
    }
  });

  it("starts an unattended turn when a Discord mention matches", async () => {
    const bot = bots.createBot();
    persistAllowRule({ botId: bot.id, tool: "shell", summary: "git status", behavior: "allow", always: true });
    const auditBefore = readAudit().length;
    const routine = routines.createRoutine({
      botId: bot.id,
      name: "Mentions",
      prompt: "Handle the mention",
      schedule: { kind: "discord", match: "mention" },
    });
    expect(routine.schedule).toMatchObject({ kind: "listener", source: "discord", match: "mention" });
    await routines.handleExternalEvent(discordMessage({ id: "in-9", text: "hey <@bot>", selfUserId: "bot" }));
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ botId: bot.id, text: "Handle the mention", unattended: true });
    expect(started[0].systemNote).toContain(UNTRUSTED_WEBHOOK_BEGIN);
    expect(readAudit().length).toBe(auditBefore);
    expect(resolveApprovalsForTriggerEvent(discordMessage({ id: "in-9", text: "hey <@bot>", selfUserId: "bot" }))).toBeNull();
  });

  it("a group fires once when either child matches, and ignores a non-match", async () => {
    const bot = bots.createBot();
    routines.createRoutine({
      botId: bot.id,
      name: "Any of",
      prompt: "Grouped",
      schedule: {
        kind: "group",
        anyOf: [
          { kind: "slack", channel: "#eng", match: "mention" },
          { kind: "discord", match: "dm" },
        ],
      },
    });
    await routines.handleExternalEvent(discordMessage({ id: "dm-1", isDm: true, text: "hi" }));
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ unattended: true, text: "Grouped" });
    started = [];
    await routines.handleExternalEvent(discordMessage({ id: "ch-1", guildId: "10", text: "hi" }));
    expect(started).toEqual([]);
  });

  it("does not fire a cron routine from an inbound Discord event", async () => {
    const bot = bots.createBot();
    routines.createRoutine({
      botId: bot.id,
      name: "Morning",
      prompt: "Brief me",
      schedule: { kind: "interval", everyMinutes: 15 },
    });
    await routines.handleExternalEvent(discordMessage({ text: "<@bot>", selfUserId: "bot" }));
    expect(started).toEqual([]);
  });
});
