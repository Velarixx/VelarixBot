import { describe, expect, it } from "vitest";

import {
  activityOutcome,
  activityStatusFromOutcome,
  completedNote,
  createActivityIndex,
  failedNote,
  isActivityRunning,
  rememberToolCompletion,
  releaseThreadItems,
  runningActivities,
  runningTool,
  settledTool,
  takePendingCompletion,
  terminalToolStatus,
  trackOpenTool,
} from "./activity-status.ts";

describe("activity terminal states", () => {
  it("maps complete / fail / cancel / timeout to distinct statuses", () => {
    expect(activityStatusFromOutcome(true)).toBe("completed");
    expect(activityStatusFromOutcome(false)).toBe("failed");
    expect(activityStatusFromOutcome(false, "cancelled")).toBe("cancelled");
    expect(activityStatusFromOutcome(true, "interrupted")).toBe("cancelled");
    expect(activityStatusFromOutcome(false, "timed_out")).toBe("timed_out");
    expect(activityStatusFromOutcome(false, "lease timeout")).toBe("timed_out");
    expect(activityStatusFromOutcome(false, "computer busy — in use by Ada")).toBe("timed_out");
    expect(activityOutcome(false, "cancelled")).toEqual({ ok: false, status: "cancelled" });
    expect(activityOutcome(true, null)).toEqual({ ok: true, status: "completed" });
  });

  it("treats provider tool statuses as terminal or still running", () => {
    expect(terminalToolStatus("completed")).toEqual({ ok: true });
    expect(terminalToolStatus("failed")).toEqual({ ok: false });
    expect(terminalToolStatus("cancelled")).toEqual({ ok: false, reason: "cancelled" });
    expect(terminalToolStatus("timed out")).toEqual({ ok: false, reason: "timed_out" });
    expect(terminalToolStatus("in_progress")).toBeNull();
  });

  it("redacts secrets in both the chip label and the stored command", () => {
    const tool = runningTool("curl -H token=sk-live-supersecret https://example.test\n--verbose");
    expect(tool.name).toContain("[redacted]");
    expect(tool.name).not.toContain("sk-live-supersecret");
    expect(tool.command).toContain("[redacted]");
    expect(tool.command).not.toContain("sk-live-supersecret");
    expect(tool.command).toContain("\n--verbose");
    expect(isActivityRunning(tool)).toBe(true);
    expect(isActivityRunning(settledTool(tool, "completed"))).toBe(false);
    expect(completedNote("Messaged @Helper")).toEqual({
      name: "Messaged @Helper",
      ok: true,
      status: "completed",
    });
    expect(failedNote("Delegated to @Ops", "cancelled")).toMatchObject({
      ok: false,
      status: "cancelled",
    });
  });
});

describe("activity event ordering", () => {
  it("patches a started tool when its completion arrives later", () => {
    const index = createActivityIndex();
    trackOpenTool(index, "thread-a", "item-1", "msg-1");
    const outcome = activityOutcome(true);
    expect(rememberToolCompletion(index, "thread-a", "item-1", outcome)).toBe("msg-1");
    expect(rememberToolCompletion(index, "thread-a", "item-1", outcome)).toBeNull();
  });

  it("applies a completion that arrives before the matching start", () => {
    const index = createActivityIndex();
    const outcome = activityOutcome(false, "cancelled");
    expect(rememberToolCompletion(index, "thread-a", "item-late", outcome)).toBeNull();
    expect(takePendingCompletion(index, "thread-a", "item-late")).toEqual(outcome);
    expect(takePendingCompletion(index, "thread-a", "item-late")).toBeNull();
  });

  it("does not let a later tool's start steal an earlier item's pending completion", () => {
    const index = createActivityIndex();
    rememberToolCompletion(index, "thread-a", "item-1", activityOutcome(false, "timed_out"));
    trackOpenTool(index, "thread-a", "item-2", "msg-2");
    expect(takePendingCompletion(index, "thread-a", "item-2")).toBeNull();
    expect(rememberToolCompletion(index, "thread-a", "item-2", activityOutcome(true))).toBe("msg-2");
    expect(takePendingCompletion(index, "thread-a", "item-1")).toEqual({
      ok: false,
      status: "timed_out",
    });
  });

  it("scopes item ids per thread so two bots cannot cross-patch", () => {
    const index = createActivityIndex();
    trackOpenTool(index, "thread-a", "shared-id", "msg-a");
    trackOpenTool(index, "thread-b", "shared-id", "msg-b");
    expect(rememberToolCompletion(index, "thread-b", "shared-id", activityOutcome(true))).toBe("msg-b");
    expect(rememberToolCompletion(index, "thread-a", "shared-id", activityOutcome(false))).toBe("msg-a");
  });

  it("sweeping a later workflow step settles earlier still-running activities", () => {
    const index = createActivityIndex();
    trackOpenTool(index, "thread-a", "item-1", "msg-1");
    trackOpenTool(index, "thread-a", "item-2", "msg-2");
    rememberToolCompletion(index, "thread-a", "item-2", activityOutcome(true));
    expect(releaseThreadItems(index, "thread-a")).toEqual(["msg-1"]);
    expect(releaseThreadItems(index, "thread-a")).toEqual([]);
  });
});

describe("reload reconstructs terminal activity state", () => {
  it("snapshot messages plus later patches keep settled chips settled", () => {
    const snapshot = [
      { id: "m-run", kind: "activity", tool: runningTool("echo one") },
      { id: "m-done", kind: "activity", tool: settledTool(runningTool("echo two"), "completed") },
    ];
    expect(runningActivities(snapshot).map((m) => m.id)).toEqual(["m-run"]);

    const reloaded = snapshot.map((m) =>
      m.id === "m-run" ? { ...m, tool: settledTool(m.tool, "cancelled") } : m,
    );
    expect(runningActivities(reloaded)).toEqual([]);
    expect(reloaded[0]?.tool).toMatchObject({ ok: false, status: "cancelled" });
    expect(reloaded[1]?.tool).toMatchObject({ ok: true, status: "completed" });
  });

  it("reconnect fold applies an out-of-order completion after the start frame", () => {
    const index = createActivityIndex();
    const frames = [
      { type: "item.completed" as const, threadId: "t", itemId: "i1", ok: false, stopReason: "cancelled" },
      { type: "item.started" as const, threadId: "t", itemId: "i1", title: "sleep 30" },
    ];
    const messages: Array<{ id: string; kind: string; tool?: ReturnType<typeof runningTool> }> = [];
    for (const frame of frames) {
      if (frame.type === "item.completed") {
        const id = rememberToolCompletion(
          index,
          frame.threadId,
          frame.itemId,
          activityOutcome(frame.ok, frame.stopReason),
        );
        if (id) {
          const existing = messages.find((m) => m.id === id);
          if (existing) existing.tool = settledTool(existing.tool, activityOutcome(frame.ok, frame.stopReason).status);
        }
      } else {
        const pending = takePendingCompletion(index, frame.threadId, frame.itemId);
        const tool = pending
          ? settledTool(runningTool(frame.title), pending.status)
          : runningTool(frame.title);
        messages.push({ id: "m-1", kind: "activity", tool });
        if (!pending) trackOpenTool(index, frame.threadId, frame.itemId, "m-1");
      }
    }
    expect(messages[0]?.tool).toMatchObject({ ok: false, status: "cancelled" });
    expect(runningActivities(messages)).toEqual([]);
  });
});
