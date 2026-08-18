import { describe, expect, it } from "vitest";
import { nextFlushBotIds } from "@/lib/prompt-queue";
import { initialState, newBotRequestBody, reducer, type Bot, type Group } from "./store";

function bot(over: Partial<Bot> & Pick<Bot, "id">): Bot {
  return {
    threadId: "thread-1",
    name: "Scout",
    title: "",
    description: "",
    notifications: true,
    color: "green",
    unread: false,
    busy: false,
    state: "IDLE",
    usage: { input: 0, output: 0, cost: null },
    modelSelection: { instanceId: "inst", model: "model" },
    messages: [],
    ...over,
  };
}

describe("connection lifecycle", () => {
  it("distinguishes initial connection from a reconnect without forgetting prior success", () => {
    const stillStarting = reducer(initialState, { type: "connected", value: false });
    expect(stillStarting.connected).toBe(false);
    expect(stillStarting.hasConnected).toBe(false);

    const online = reducer(stillStarting, { type: "connected", value: true });
    expect(online.connected).toBe(true);
    expect(online.hasConnected).toBe(true);

    const reconnecting = reducer(online, { type: "connected", value: false });
    expect(reconnecting.connected).toBe(false);
    expect(reconnecting.hasConnected).toBe(true);
  });
});

describe("composer prompt queue (store path)", () => {
  it("enqueues while busy, then flushQueue drains FIFO once idle", () => {
    let state = reducer(initialState, { type: "hydrate", bots: [bot({ id: "bot-1", busy: true, state: "RUNNING" })] });

    // send-while-busy: the wrapper dispatches enqueue instead of send/POST
    state = reducer(state, {
      type: "enqueue",
      botId: "bot-1",
      item: { id: "q-1", text: "first follow-up", attachments: [] },
    });
    state = reducer(state, {
      type: "enqueue",
      botId: "bot-1",
      item: { id: "q-2", text: "second follow-up", attachments: [] },
    });
    expect(state.queued["bot-1"]?.map((item) => item.id)).toEqual(["q-1", "q-2"]);
    expect(state.bots[0]?.busy).toBe(true);
    // useEffect does not flush while the turn is running
    expect(nextFlushBotIds(state.bots, state.queued)).toEqual([]);
    state = reducer(state, { type: "flushQueue", botId: "bot-1" });
    expect(state.queued["bot-1"]?.map((item) => item.id)).toEqual(["q-1", "q-2"]);

    // interrupt/stop does not clear the queue (wrapper still POSTs /interrupt)
    const afterInterrupt = reducer(state, { type: "interrupt", botId: "bot-1" });
    expect(afterInterrupt.queued["bot-1"]?.map((item) => item.id)).toEqual(["q-1", "q-2"]);
    expect(afterInterrupt.bots[0]?.busy).toBe(true);

    // turn ends (SSE botPatched) — same condition the store useEffect walks
    state = reducer(state, { type: "botPatched", bot: { id: "bot-1", busy: false, state: "DONE" } });
    expect(state.bots[0]?.busy).toBe(false);
    expect(nextFlushBotIds(state.bots, state.queued)).toEqual(["bot-1"]);

    state = reducer(state, { type: "flushQueue", botId: "bot-1" });
    expect(state.queued["bot-1"]?.map((item) => item.id)).toEqual(["q-2"]);
    expect(state.bots[0]?.busy).toBe(true);
    // still working on the drained prompt — do not take q-2 yet
    expect(nextFlushBotIds(state.bots, state.queued)).toEqual([]);
    state = reducer(state, { type: "flushQueue", botId: "bot-1" });
    expect(state.queued["bot-1"]?.map((item) => item.id)).toEqual(["q-2"]);
  });

  it("cancels a queued prompt before flushQueue would send it", () => {
    let state = reducer(initialState, { type: "hydrate", bots: [bot({ id: "bot-1", busy: true, state: "RUNNING" })] });
    state = reducer(state, {
      type: "enqueue",
      botId: "bot-1",
      item: { id: "q-1", text: "keep", attachments: [] },
    });
    state = reducer(state, {
      type: "enqueue",
      botId: "bot-1",
      item: { id: "q-2", text: "drop", attachments: [] },
    });
    state = reducer(state, { type: "cancelQueued", botId: "bot-1", id: "q-2" });
    state = reducer(state, { type: "botPatched", bot: { id: "bot-1", busy: false } });
    expect(nextFlushBotIds(state.bots, state.queued)).toEqual(["bot-1"]);
    state = reducer(state, { type: "flushQueue", botId: "bot-1" });
    expect(state.queued["bot-1"]).toEqual([]);
    expect(state.bots[0]?.busy).toBe(true);
  });

  it("does not delete the last bot in the workspace", () => {
    const only = bot({ id: "bot-1" });
    const start = reducer(initialState, { type: "hydrate", bots: [only] });
    const after = reducer(start, { type: "deleteBot", botId: "bot-1" });
    expect(after.bots).toHaveLength(1);
    expect(after.bots[0]?.id).toBe("bot-1");

    let two = reducer(initialState, { type: "hydrate", bots: [bot({ id: "bot-1" }), bot({ id: "bot-2", name: "Helper" })] });
    two = reducer(two, { type: "deleteBot", botId: "bot-1" });
    expect(two.bots.map((b) => b.id)).toEqual(["bot-2"]);
  });
});

describe("per-bot enabledApps (hub enable)", () => {
  it("PATCHes only the selected bot — a second bot's list is unchanged", () => {
    let state = reducer(initialState, {
      type: "hydrate",
      bots: [
        bot({ id: "bot-a", name: "Scout", enabledApps: [] }),
        bot({ id: "bot-b", name: "Helper", enabledApps: ["gmail"] }),
      ],
    });
    state = reducer(state, { type: "select", id: "bot-a" });
    state = reducer(state, {
      type: "updateBot",
      botId: state.selectedId,
      patch: { enabledApps: ["slack"] },
    });
    expect(state.bots.find((b) => b.id === "bot-a")?.enabledApps).toEqual(["slack"]);
    expect(state.bots.find((b) => b.id === "bot-b")?.enabledApps).toEqual(["gmail"]);
  });
});

describe("A ⇄ B DM groups", () => {
  const dm = (over: Partial<Group> = {}): Group => ({
    id: "g-1",
    threadId: "thread-dm",
    name: "Chief ⇄ Helper",
    memberIds: ["bot-1", "bot-2"],
    unread: true,
    createdAt: 1,
    dm: true,
    messages: [],
    ...over,
  });

  it("hydrates groups and opens one via selectGroup", () => {
    let state = reducer(initialState, {
      type: "hydrate",
      bots: [bot({ id: "bot-1" })],
      groups: [dm()],
    });
    expect(state.groups).toHaveLength(1);
    state = reducer(state, { type: "selectGroup", id: "g-1" });
    expect(state.selectedGroupId).toBe("g-1");
    expect(state.groups[0]?.unread).toBe(false);
  });

  it("groupUpsert without messages keeps the existing transcript", () => {
    let state = reducer(initialState, { type: "hydrate", bots: [bot({ id: "bot-1" })], groups: [dm()] });
    state = reducer(state, {
      type: "messageAdded",
      threadId: "thread-dm",
      message: { id: "m-1", role: "bot", kind: "text", text: "keep me", at: 2 },
    });
    state = reducer(state, {
      type: "groupUpsert",
      group: { id: "g-1", threadId: "thread-dm", name: "Chief ⇄ Helper", memberIds: ["bot-1", "bot-2"], unread: true, createdAt: 1, dm: true },
    });
    expect(state.groups[0]?.messages).toHaveLength(1);
    expect(state.groups[0]?.messages[0]?.text).toBe("keep me");
    expect(state.groups[0]?.unread).toBe(true);
  });

  it("folds a message onto the DM thread", () => {
    let state = reducer(initialState, { type: "hydrate", bots: [bot({ id: "bot-1" })], groups: [dm()] });
    state = reducer(state, {
      type: "messageAdded",
      threadId: "thread-dm",
      message: {
        id: "m-1",
        role: "bot",
        kind: "text",
        text: "do this",
        at: 2,
        from: { botId: "bot-1", name: "Chief" },
      },
    });
    expect(state.groups[0]?.messages).toHaveLength(1);
    expect(state.groups[0]?.messages[0]?.text).toBe("do this");
  });
});

describe("one-step named create", () => {
  it("newBotRequestBody always sends name and omits computer/alwaysAllow", () => {
    expect(newBotRequestBody({ name: "  Scout  ", title: " Field ", color: "green" })).toEqual({
      name: "Scout",
      title: "Field",
      color: "green",
    });
    expect(newBotRequestBody({ name: "Scout" })).toEqual({ name: "Scout" });
    expect(JSON.stringify(newBotRequestBody({ name: "Scout", model: "claude-sonnet-5" }))).not.toMatch(
      /computer|alwaysAllow/,
    );
  });

  it("Plus opens the modal; confirm closes it; botAdded paints the typed name first", () => {
    let state = reducer(initialState, { type: "toggleCreateBot", open: true });
    expect(state.createBotOpen).toBe(true);
    expect(state.bots).toEqual([]);
    state = reducer(state, { type: "newBot", name: "Scout", title: "Field scout", color: "green" });
    expect(state.createBotOpen).toBe(false);
    const created = bot({ id: "bot-scout", name: "Scout", title: "Field scout", color: "green" });
    state = reducer(state, { type: "botAdded", bot: created });
    expect(state.bots[0]?.name).toBe("Scout");
    expect(state.bots[0]?.name).not.toBe("New Bot");
    expect(state.selectedId).toBe("bot-scout");
  });
});

describe("setup card → Settings", () => {
  it("Switch model in Settings on a setup card opens Settings", () => {
    let state = reducer(initialState, {
      type: "hydrate",
      bots: [
        bot({
          id: "bot-1",
          messages: [
            {
              id: "m-setup",
              role: "bot",
              kind: "options",
              at: 1,
              card: {
                title: "This engine is not available",
                subtitle: "`claude` CLI not found",
                options: ["Switch model in Settings"],
                requestType: "setup",
              },
            },
          ],
        }),
      ],
    });
    expect(state.settingsOpen).toBe(false);
    state = reducer(state, {
      type: "answerCard",
      botId: "bot-1",
      messageId: "m-setup",
      answer: "Switch model in Settings",
    });
    expect(state.settingsOpen).toBe(true);
    expect(state.computerOpen).toBe(false);
    expect(state.appSettingsOpen).toBe(false);
    expect(state.bots[0]?.messages[0]?.card?.answered).toBe("Switch model in Settings");
  });
});
