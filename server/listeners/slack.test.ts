import { describe, expect, it } from "vitest";

import { extractSlackMessages, pollSlackListener, selectSlackMatch, SLACK_NOT_CONNECTED, slackMessageMatches } from "./slack.ts";

describe("slack listener match", () => {
  it("mention / keyword / message filters", () => {
    expect(slackMessageMatches("hi <@U123> there", "mention")).toBe(true);
    expect(slackMessageMatches("plain note", "mention")).toBe(false);
    expect(slackMessageMatches("please deploy now", "keyword", "deploy")).toBe(true);
    expect(slackMessageMatches("please deploy now", "keyword", "ship")).toBe(false);
    expect(slackMessageMatches("anything", "message")).toBe(true);
  });

  it("first poll primes; a new match fires once; duplicate cursor does not", () => {
    const history = [{ id: "100.0", text: "old deploy" }];
    const primed = selectSlackMatch(history, "keyword", "deploy", null);
    expect(primed).toEqual({ match: null, nextCursor: "100.0" });
    const withNew = selectSlackMatch([{ id: "101.5", text: "please deploy" }, ...history], "keyword", "deploy", primed.nextCursor);
    expect(withNew.match).toEqual({ id: "101.5", text: "please deploy" });
    const again = selectSlackMatch([{ id: "101.5", text: "please deploy" }, ...history], "keyword", "deploy", withNew.nextCursor);
    expect(again.match).toBeNull();
  });

  it("extracts messages from nested Composio payloads", () => {
    const messages = extractSlackMessages({
      data: { messages: [{ ts: "1.0", text: "hi", type: "message" }, { ts: "0.5", type: "channel_join" }] },
    });
    expect(messages).toEqual([{ id: "1.0", text: "hi" }]);
  });
});

describe("pollSlackListener", () => {
  it("skips when Composio is unset — same honest error as create", async () => {
    const result = await pollSlackListener(
      { kind: "listener", source: "slack", channel: "#eng", match: "message" },
      null,
      {
        cfg: {},
        feed: { listMessages: async () => [{ id: "1.0", text: "hi" }] },
      },
    );
    expect(result).toEqual({ status: "skip", reason: SLACK_NOT_CONNECTED, cursor: null });
  });

  it("skips when Slack is not connected", async () => {
    const result = await pollSlackListener(
      { kind: "listener", source: "slack", channel: "#eng", match: "message" },
      null,
      {
        cfg: { composio: { key: "ck_fake" } },
        feed: { listMessages: async () => [{ id: "1.0", text: "hi" }] },
        connectionStatus: async () => ({ slack: { connected: false, status: "unknown" } }),
      },
    );
    expect(result).toEqual({ status: "skip", reason: SLACK_NOT_CONNECTED, cursor: null });
  });
});
