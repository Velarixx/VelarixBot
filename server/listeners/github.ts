// Outbound GitHub poll for kind: "listener" source: "github".
// One concrete owner/name + an explicit event allow-list. Uses the existing
// cfg.github.token (or GITHUB_TOKEN / GH_TOKEN). No inbound webhook.
import type { GithubListenerEvent, GithubListenerSchedule } from "../store.ts";

export const GITHUB_EVENT_TYPE: Record<GithubListenerEvent, string> = {
  push: "PushEvent",
  pull_request: "PullRequestEvent",
  issues: "IssuesEvent",
  issue_comment: "IssueCommentEvent",
  release: "ReleaseEvent",
  create: "CreateEvent",
  delete: "DeleteEvent",
  fork: "ForkEvent",
  watch: "WatchEvent",
  pull_request_review: "PullRequestReviewEvent",
  pull_request_review_comment: "PullRequestReviewCommentEvent",
};

export const GITHUB_NO_TOKEN =
  "skipped: GitHub token is not configured. Add it in App Settings. Never ask the user to paste a token in chat.";

export interface GithubEvent {
  id: string;
  type: string;
}

export interface GithubFeed {
  listEvents(repo: { owner: string; name: string }, token: string): Promise<GithubEvent[]>;
}

function compareIds(a: string, b: string): number {
  try {
    const d = BigInt(a) - BigInt(b);
    return d === 0n ? 0 : d > 0n ? 1 : -1;
  } catch {
    return a < b ? -1 : a > b ? 1 : 0;
  }
}

function maxId(events: GithubEvent[]): string | null {
  let max: string | null = null;
  for (const event of events) {
    if (!event.id) continue;
    if (max === null || compareIds(event.id, max) > 0) max = event.id;
  }
  return max;
}

/** Newer-than-cursor events whose type is on the allow-list. First poll
 * (no cursor) only primes the cursor — historical events do not fire. */
export function selectGithubMatch(
  events: GithubEvent[],
  allow: readonly GithubListenerEvent[],
  cursor: string | null,
): { match: GithubEvent | null; nextCursor: string | null } {
  const newest = maxId(events);
  const nextCursor = newest ?? cursor;
  if (!cursor) return { match: null, nextCursor };
  const allowed = new Set(allow.map((e) => GITHUB_EVENT_TYPE[e]));
  let match: GithubEvent | null = null;
  for (const event of events) {
    if (!event.id || compareIds(event.id, cursor) <= 0) continue;
    if (!allowed.has(event.type)) continue;
    if (!match || compareIds(event.id, match.id) > 0) match = event;
  }
  return { match, nextCursor };
}

export function createGithubFeed(fetchImpl: typeof fetch = fetch): GithubFeed {
  return {
    async listEvents(repo, token) {
      const url = `https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/events?per_page=30`;
      const res = await fetchImpl(url, {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "x-github-api-version": "2022-11-28",
          "user-agent": "VelarixBot",
        },
        signal: AbortSignal.timeout(15_000),
      });
      if (res.status === 401) throw new Error("skipped: GitHub token was rejected");
      if (res.status === 403) throw new Error("skipped: GitHub repo access denied");
      if (res.status === 404) throw new Error("skipped: GitHub repo not found");
      if (!res.ok) throw new Error(`skipped: GitHub poll failed (HTTP ${res.status})`);
      const body: unknown = await res.json();
      if (!Array.isArray(body)) return [];
      return body
        .map((row) => {
          const r = row as { id?: unknown; type?: unknown };
          return { id: String(r.id ?? ""), type: String(r.type ?? "") };
        })
        .filter((e) => e.id && e.type);
    },
  };
}

export async function pollGithubListener(
  schedule: GithubListenerSchedule,
  cursor: string | null,
  deps: { token: string | undefined; feed: GithubFeed },
): Promise<{ status: "match" | "no-match" | "skip"; reason?: string; cursor: string | null }> {
  const repo = schedule.repo;
  const events = schedule.events ?? [];
  if (!repo?.owner || !repo.name || !events.length) {
    return { status: "skip", reason: "skipped: github listener needs one owner/name repo and an event list", cursor };
  }
  const token = deps.token?.trim();
  if (!token) return { status: "skip", reason: GITHUB_NO_TOKEN, cursor };
  const feed = await deps.feed.listEvents(repo, token);
  const { match, nextCursor } = selectGithubMatch(feed, events, cursor);
  if (match) return { status: "match", cursor: nextCursor };
  return { status: "no-match", cursor: nextCursor };
}
