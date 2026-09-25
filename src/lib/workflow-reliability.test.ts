import { afterEach, describe, expect, it, vi } from "vitest";
import { initialState, reducer, type Bot, type Message } from "../state/store";
import { freshFrame, newestFrame, FRAME_STALE_MS } from "./computer-frame";
import { createStreamText } from "./stream-text";
import { readDraft, updateDraft } from "./composer-drafts";
import { historyWindow, HISTORY_WINDOW } from "./history-window";
import { nextFlushBotIds, persistPromptQueue, restorePromptQueue } from "./prompt-queue";

const bot = { id: "a", threadId: "thread-a", messages: [], busy: false } as unknown as Bot;
const prompt = { id: "stable-id", text: "Preserve me", attachments: [{ path: "/example.png" }] };
afterEach(() => vi.unstubAllGlobals());

function fakeStorage() {
  const values = new Map<string, string>();
  vi.stubGlobal("sessionStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
}

describe("pending message delivery", () => {
  it("starts a fresh working state before server acknowledgment and clears stale errors", () => {
    const old = { ...bot, state: "BLOCKED" as const, stateDetail: "old failure", stateCode: "turn_failed", workflowStatus: "blocked" as const, workflowStopReason: "old failure" };
    let state: typeof initialState = { ...initialState, bots: [old], queued: { a: [prompt] } };
    const before = Date.now();
    state = reducer(state, { type: "flushQueue", botId: "a" });
    expect(state.bots[0]).toMatchObject({ busy: true, state: "RUNNING", workflowStatus: "working" });
    expect(state.bots[0].pendingSendStartedAt).toBeGreaterThanOrEqual(before);
    expect(state.bots[0].stateDetail).toBeUndefined();
    expect(state.bots[0].workflowStopReason).toBeUndefined();
    state = reducer(state, { type: "messageAdded", threadId: bot.threadId, message: { id: "accepted", role: "user", kind: "text", text: prompt.text, at: Date.now() } });
    expect(state.bots[0].pendingSendStartedAt).toBeUndefined();
    state = reducer({ ...state, bots: [old] }, { type: "botPatched", bot: { id: "a", state: "DONE", busy: false } });
    expect(state.bots[0].stateDetail).toBeUndefined();
    expect(state.bots[0].stateCode).toBeUndefined();
  });
  it("keeps the payload until acceptance and blocks failed or stopped queue heads", () => {
    let state = reducer(initialState, { type: "hydrate", bots: [bot] });
    state = reducer(state, { type: "enqueue", botId: "a", item: prompt });
    state = reducer(state, { type: "flushQueue", botId: "a" });
    expect(state.queued.a[0]).toMatchObject({ ...prompt, status: "sending" });
    state = reducer(state, { type: "promptFailed", botId: "a", id: prompt.id, error: "Network lost" });
    expect(nextFlushBotIds(state.bots, state.queued, state.queuePaused)).toEqual([]);
    state = reducer(state, { type: "retryPrompt", botId: "a", id: prompt.id });
    expect(state.queued.a[0].id).toBe(prompt.id);
    state = reducer(state, { type: "interrupt", botId: "a" });
    expect(nextFlushBotIds(state.bots, state.queued, state.queuePaused)).toEqual([]);
    state = reducer(state, { type: "resumeQueue", botId: "a" });
    expect(nextFlushBotIds(state.bots, state.queued, state.queuePaused)).toEqual(["a"]);
    state = reducer(state, { type: "promptSent", botId: "a", id: prompt.id });
    expect(state.queued.a).toEqual([]);
  });

  it("restores ambiguous deliveries with the same key and requires explicit resume", () => {
    fakeStorage();
    persistPromptQueue({ a: [{ ...prompt, status: "sending" }] });
    const restored = restorePromptQueue();
    expect(restored.queued.a[0]).toMatchObject({ ...prompt, status: "failed" });
    expect(restored.queuePaused.a).toBe(true);
  });

  it("editing a failed head pauses later prompts without blocking a lone corrected send", () => {
    const failed = { ...prompt, status: "failed" as const };
    const state = { ...initialState, bots: [bot], queued: { a: [failed] } };
    expect(reducer(state, { type: "editQueued", botId: "a", id: failed.id }).queuePaused.a).toBe(false);
    const withFollowup = { ...state, queued: { a: [failed, { ...prompt, id: "follow-up" }] } };
    const edited = reducer(withFollowup, { type: "editQueued", botId: "a", id: failed.id });
    expect(edited.queued.a.map((item) => item.id)).toEqual(["follow-up"]);
    expect(nextFlushBotIds(edited.bots, edited.queued, edited.queuePaused)).toEqual([]);
  });
});

it("isolates drafts, attachment chips and skills by conversation", () => {
  fakeStorage();
  updateDraft("draft-a", () => ({ text: "first\nsecond", chips: [{ id: "file", name: "a.png", path: "/a.png" }], skills: [{ id: "skill", name: "Review" }] }));
  expect(readDraft("draft-b")).toEqual({ text: "", chips: [], skills: [] });
  updateDraft("draft-b", (current) => ({ ...current, text: "another draft" }));
  expect(readDraft("draft-a").text).toBe("first\nsecond");
  expect(readDraft("draft-a").chips).toHaveLength(1);
});

it("notifies only the streaming conversation and clears the settled text", () => {
  const stream = createStreamText();
  const a = vi.fn(), b = vi.fn();
  stream.subscribe("a", a); stream.subscribe("b", b);
  stream.append("a", "Hello"); stream.append("a", " world");
  expect(stream.get("a")).toBe("Hello world");
  expect(b).not.toHaveBeenCalled();
  stream.clear("a");
  expect(stream.get("a")).toBe("");
  expect(a).toHaveBeenCalledTimes(3);
});

it("prefers a newer poll over an old SSE frame and expires stalled streaming", () => {
  const streamed = { png: "old", mime: "image/png", at: 1000 };
  const polled = { png: "new", mime: "image/png", at: 2000 };
  expect(newestFrame(streamed, polled)).toBe(polled);
  expect(freshFrame(streamed, 1000 + FRAME_STALE_MS)).toBe(false);
  expect(freshFrame(polled, 2500)).toBe(true);
});

it("bounds the rendered history and keeps an older window anchored as new messages arrive", () => {
  const messages = Array.from({ length: 10000 }, (_, i) => ({ id: `m-${i}`, kind: "text", role: "user", at: i } as Message));
  expect(historyWindow(messages, null).messages).toHaveLength(HISTORY_WINDOW);
  expect(historyWindow(messages, null).messages.at(-1)?.id).toBe("m-9999");
  const older = historyWindow(messages, "m-500");
  expect(older.messages[0].id).toBe("m-500");
  expect(historyWindow([...messages, { id: "new" } as Message], "m-500").messages).toEqual(older.messages);
});

it("merges paged history without duplicates and preserves it across overlapping resync", () => {
  const m = (id: string) => ({ id, kind: "text", role: "user", at: 1 } as Message);
  let state = reducer(initialState, { type: "hydrate", bots: [{ ...bot, messages: [m("b"), m("c")], hasMore: true }] });
  state = reducer(state, { type: "historyLoaded", threadId: bot.threadId, messages: [m("a"), m("b")], hasMore: false });
  state = reducer(state, { type: "hydrate", bots: [{ ...bot, messages: [m("c"), m("d")], hasMore: true }] });
  expect(state.bots[0].messages.map((message) => message.id)).toEqual(["a", "b", "c", "d"]);
  expect(state.bots[0].hasMore).toBe(false);
});
