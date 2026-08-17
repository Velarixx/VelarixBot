// kind: "listener" poll — GitHub via cfg.github.token, Slack via Composio.
// Called from the existing routines tick. No second scheduler.
import type { AppConfig } from "../config.ts";
import * as composio from "../composio.ts";
import type { RoutineSchedule } from "../store.ts";
import { createGithubFeed, pollGithubListener, type GithubFeed } from "./github.ts";
import { createSlackFeed, pollSlackListener, type SlackFeed } from "./slack.ts";

export type ListenerPollResult =
  | { status: "match"; cursor: string | null }
  | { status: "no-match"; cursor: string | null }
  | { status: "skip"; reason: string; cursor: string | null };

export type ListenerPoller = (
  schedule: Extract<RoutineSchedule, { kind: "listener" }>,
  cursor: string | null,
) => Promise<ListenerPollResult>;

export function createListenerPoller(deps: {
  cfg: () => AppConfig;
  githubFeed?: GithubFeed;
  slackFeed?: SlackFeed;
  connectionStatus?: typeof composio.connectionStatus;
}): ListenerPoller {
  const githubFeed = deps.githubFeed ?? createGithubFeed();
  const slackFeed = deps.slackFeed ?? createSlackFeed();
  return async (schedule, cursor) => {
    try {
      if (schedule.source === "github") {
        return await pollGithubListener(schedule, cursor, {
          token: deps.cfg().github?.token,
          feed: githubFeed,
        });
      }
      return await pollSlackListener(schedule, cursor, {
        cfg: deps.cfg(),
        feed: slackFeed,
        connectionStatus: deps.connectionStatus,
      });
    } catch (e) {
      const reason = e instanceof Error ? e.message : "skipped: listener poll failed";
      return { status: "skip", reason: reason.startsWith("skipped:") ? reason : `skipped: ${reason}`, cursor };
    }
  };
}

export { GITHUB_NO_TOKEN } from "./github.ts";
export { SLACK_NOT_CONNECTED } from "./slack.ts";
