import { describe, expect, it } from "vitest";
import { nextFlushBotIds } from "@/lib/prompt-queue";
import { initialState, reducer, type Bot } from "./store";

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
});
