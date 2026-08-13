import { describe, expect, it } from "vitest";
import { notifyCopy, shouldNotify } from "./notify";

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

  it("sends nothing when the bot toggle is off", () => {
    expect(shouldNotify(off, { type: "request.opened" })).toBe(false);
    expect(shouldNotify(off, { type: "turn.completed", ok: true })).toBe(false);
    expect(shouldNotify(off, { type: "turn.completed", ok: false, stopReason: "BLOCKED" })).toBe(false);
    expect(shouldNotify(off, { type: "stall.nudge" })).toBe(false);
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
    expect(notifyCopy(on, { type: "turn.completed", ok: true })).toEqual({ title: "Scout", body: "Finished" });
    expect(notifyCopy(on, { type: "turn.completed", ok: false })).toEqual({ title: "Scout", body: "Didn't finish" });
    expect(notifyCopy(on, { type: "turn.completed", ok: true, stopReason: "BLOCKED" })).toEqual({
      title: "Scout",
      body: "Didn't finish",
    });
  });
});
