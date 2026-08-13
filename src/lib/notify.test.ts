import { describe, expect, it } from "vitest";
import { notifyCopy, notifyEventEnabled, shouldNotify, unreadBotCount } from "./notify";

const on = { notifications: true, name: "Scout" };
const off = { notifications: false, name: "Scout" };

describe("shouldNotify", () => {
  it("toasts request.opened and turn.completed when the bot toggle is on", () => {
    expect(shouldNotify(on, { type: "request.opened" })).toBe(true);
    expect(shouldNotify(on, { type: "turn.completed", ok: true })).toBe(true);
    expect(shouldNotify(on, { type: "turn.completed", ok: false })).toBe(true);
    expect(shouldNotify(on, { type: "turn.completed", ok: false, stopReason: "BLOCKED" })).toBe(true);
    expect(shouldNotify(on, { type: "stall.nudge" })).toBe(true);
  });

  it("toasts a fake peer-reply event when that notify event is enabled", () => {
    expect(shouldNotify(on, { type: "peer.reply" })).toBe(true);
    expect(shouldNotify({ ...on, notifyEvents: { "peer.reply": true } }, { type: "peer.reply" })).toBe(true);
    expect(shouldNotify({ ...on, notifyEvents: { "peer.reply": false } }, { type: "peer.reply" })).toBe(false);
    expect(shouldNotify(off, { type: "peer.reply" })).toBe(false);
  });

  it("honors per-event granularity while the master toggle stays on", () => {
    const quietTurns = { ...on, notifyEvents: { "turn.completed": false } };
    expect(notifyEventEnabled(quietTurns, "turn.completed")).toBe(false);
    expect(shouldNotify(quietTurns, { type: "turn.completed", ok: true })).toBe(false);
    expect(shouldNotify(quietTurns, { type: "request.opened" })).toBe(true);
    expect(shouldNotify(quietTurns, { type: "peer.reply" })).toBe(true);
  });

  it("sends nothing when the bot toggle is off", () => {
    expect(shouldNotify(off, { type: "request.opened" })).toBe(false);
    expect(shouldNotify(off, { type: "turn.completed", ok: true })).toBe(false);
    expect(shouldNotify(off, { type: "turn.completed", ok: false, stopReason: "BLOCKED" })).toBe(false);
    expect(shouldNotify(off, { type: "stall.nudge" })).toBe(false);
    expect(shouldNotify(off, { type: "peer.reply" })).toBe(false);
  });

  it("ignores other runtime events", () => {
    expect(shouldNotify(on, { type: "content.delta" })).toBe(false);
    expect(shouldNotify(on, { type: "turn.started" })).toBe(false);
    expect(shouldNotify(on, { type: "runtime.error" })).toBe(false);
  });
});

describe("notifyCopy", () => {
  it("uses only local title/body strings", () => {
    expect(notifyCopy(on, { type: "request.opened" })).toEqual({ title: "Scout", body: "Needs your input" });
    expect(notifyCopy(on, { type: "stall.nudge" })).toEqual({ title: "Scout", body: "Still waiting on you" });
    expect(notifyCopy(on, { type: "peer.reply" })).toEqual({ title: "Scout", body: "A teammate replied" });
    expect(notifyCopy(on, { type: "turn.completed", ok: true })).toEqual({ title: "Scout", body: "Finished" });
    expect(notifyCopy(on, { type: "turn.completed", ok: false })).toEqual({ title: "Scout", body: "Didn't finish" });
    expect(notifyCopy(on, { type: "turn.completed", ok: true, stopReason: "BLOCKED" })).toEqual({
      title: "Scout",
      body: "Didn't finish",
    });
  });

  it("does not put peer reply text or secrets into the toast", () => {
    const copy = notifyCopy(on, { type: "peer.reply" });
    expect(JSON.stringify(copy)).not.toMatch(/hunter2|sk-|password|token/i);
    expect(copy?.body).toBe("A teammate replied");
  });
});

describe("unreadBotCount", () => {
  it("counts visible unread bots for the tray badge", () => {
    expect(
      unreadBotCount([
        { unread: true },
        { unread: true, hidden: true },
        { unread: false },
        { unread: true, hidden: false },
      ]),
    ).toBe(2);
  });
});
