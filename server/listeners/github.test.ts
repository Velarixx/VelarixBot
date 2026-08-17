import { describe, expect, it } from "vitest";

import { createGithubFeed, GITHUB_NO_TOKEN, pollGithubListener, selectGithubMatch } from "./github.ts";

const repo = { owner: "Velarixx", name: "VelarixBot" };
const allow = ["pull_request"] as const;

describe("github listener match", () => {
  it("first poll primes the cursor and does not fire on history", () => {
    const events = [
      { id: "30", type: "PullRequestEvent" },
      { id: "20", type: "PushEvent" },
    ];
    expect(selectGithubMatch(events, allow, null)).toEqual({ match: null, nextCursor: "30" });
  });

  it("a new matching event fires once; the same cursor does not", () => {
    const first = [
      { id: "30", type: "PullRequestEvent" },
      { id: "20", type: "PushEvent" },
    ];
    const primed = selectGithubMatch(first, allow, null);
    const withNew = selectGithubMatch([{ id: "40", type: "PullRequestEvent" }, ...first], allow, primed.nextCursor);
    expect(withNew.match).toEqual({ id: "40", type: "PullRequestEvent" });
    expect(withNew.nextCursor).toBe("40");
    const again = selectGithubMatch([{ id: "40", type: "PullRequestEvent" }, ...first], allow, withNew.nextCursor);
    expect(again.match).toBeNull();
    expect(again.nextCursor).toBe("40");
  });

  it("ignores events off the allow-list", () => {
    const primed = selectGithubMatch([{ id: "10", type: "PushEvent" }], allow, null);
    const next = selectGithubMatch(
      [
        { id: "12", type: "PushEvent" },
        { id: "10", type: "PushEvent" },
      ],
      allow,
      primed.nextCursor,
    );
    expect(next.match).toBeNull();
    expect(next.nextCursor).toBe("12");
  });
});

describe("pollGithubListener", () => {
  it("skips without inventing a token", async () => {
    const result = await pollGithubListener(
      { kind: "listener", source: "github", repo, events: ["push"] },
      null,
      { token: undefined, feed: { listEvents: async () => [{ id: "1", type: "PushEvent" }] } },
    );
    expect(result).toEqual({ status: "skip", reason: GITHUB_NO_TOKEN, cursor: null });
  });

  it("does not put the token on the request URL", async () => {
    const token = "ghp_not_a_real_token_for_tests";
    const seen: { url: string; auth?: string } = { url: "", auth: undefined };
    const feed = createGithubFeed(async (url, init) => {
      const headers = (init as RequestInit | undefined)?.headers as Record<string, string> | undefined;
      seen.url = String(url);
      seen.auth = headers?.authorization;
      return new Response(JSON.stringify([]), { status: 200 });
    });
    await feed.listEvents(repo, token);
    expect(seen.url).toContain("/repos/Velarixx/VelarixBot/events");
    expect(seen.url).not.toContain(token);
    expect(seen.auth).toBe(`Bearer ${token}`);
  });
});
