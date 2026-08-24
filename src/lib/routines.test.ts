import { describe, expect, it } from "vitest";

import { listenerScheduleFromForm, scheduleLabel } from "./routines";

describe("routine schedule helpers", () => {
  it("builds github and slack listener payloads with the filter fields", () => {
    expect(
      listenerScheduleFromForm({
        kind: "github",
        everyMinutes: 10,
        time: "09:00",
        repoOwner: "Velarixx",
        repoName: "VelarixBot",
        events: ["pull_request", "issues"],
        channel: "",
        match: "",
        keyword: "",
      }),
    ).toEqual({
      kind: "listener",
      source: "github",
      everyMinutes: 10,
      repo: { owner: "Velarixx", name: "VelarixBot" },
      events: ["pull_request", "issues"],
    });
    expect(
      listenerScheduleFromForm({
        kind: "slack",
        everyMinutes: 15,
        time: "09:00",
        repoOwner: "",
        repoName: "",
        events: [],
        channel: "#eng",
        match: "keyword",
        keyword: "deploy",
      }),
    ).toEqual({
      kind: "listener",
      source: "slack",
      everyMinutes: 15,
      channel: "#eng",
      match: "keyword",
      keyword: "deploy",
    });
    expect(
      listenerScheduleFromForm({
        kind: "discord",
        everyMinutes: 15,
        time: "09:00",
        repoOwner: "",
        repoName: "",
        events: [],
        channel: "",
        match: "mention",
        keyword: "",
      }),
    ).toEqual({
      kind: "listener",
      source: "discord",
      match: "mention",
    });
  });

  it("labels listeners with the concrete filter, not a generic interval", () => {
    expect(
      scheduleLabel({
        kind: "listener",
        source: "github",
        repo: { owner: "Velarixx", name: "VelarixBot" },
        events: ["push"],
      }),
    ).toBe("GitHub Velarixx/VelarixBot (push)");
    expect(scheduleLabel({ kind: "listener", source: "slack", channel: "#eng", match: "mention" })).toBe("Slack #eng (mention)");
    expect(scheduleLabel({ kind: "listener", source: "discord", match: "dm" })).toBe("Discord DM");
    expect(
      scheduleLabel({
        kind: "group",
        anyOf: [
          { kind: "listener", source: "github", repo: { owner: "Velarixx", name: "VelarixBot" }, events: ["push"] },
          { kind: "listener", source: "discord", match: "mention" },
        ],
      }),
    ).toBe("Any of: GitHub Velarixx/VelarixBot (push); Discord mention");
  });
});
