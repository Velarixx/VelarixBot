// P1.3 renderer half: the cursor fold that makes reconnect/replay safe to
// apply — duplicates (sequence at or before the cursor) are skipped, so a
// replay overlapping already-applied frames can never double-apply.
import { describe, expect, it } from "vitest";

import { advanceCursor, eventsUrl, INITIAL_CURSOR, shouldApplyFrame, type SseCursor } from "./sse-resume";

const frame = (sequence: number, streamId = "ui") => ({ streamId, sequence, kind: "bot" });

describe("sse resume cursor (renderer dedupe)", () => {
  it("applies fresh frames and advances monotonically", () => {
    let cursor: SseCursor = INITIAL_CURSOR;
    for (const n of [1, 2, 3]) {
      expect(shouldApplyFrame(cursor, frame(n))).toBe(true);
      cursor = advanceCursor(cursor, frame(n));
    }
    expect(cursor).toEqual({ streamId: "ui", sequence: 3 });
  });

  it("skips duplicates: a replay overlapping applied frames never double-applies", () => {
    let cursor: SseCursor = INITIAL_CURSOR;
    const applied: number[] = [];
    // live delivery of 1..3, then a resume replays 2..5 (overlap 2,3)
    for (const n of [1, 2, 3, /* replay: */ 2, 3, 4, 5]) {
      if (shouldApplyFrame(cursor, frame(n))) {
        applied.push(n);
        cursor = advanceCursor(cursor, frame(n));
      }
    }
    expect(applied).toEqual([1, 2, 3, 4, 5]); // each exactly once, in order
    expect(cursor.sequence).toBe(5);
  });

  it("always applies unsequenced (ephemeral) frames without touching the cursor", () => {
    const cursor: SseCursor = { streamId: "ui", sequence: 7 };
    const delta = { kind: "runtime", event: { type: "content.delta" } };
    expect(shouldApplyFrame(cursor, delta)).toBe(true);
    expect(advanceCursor(cursor, delta)).toEqual(cursor);
  });

  it("a snapshot cursor primes the fold: everything in the snapshot is a duplicate", () => {
    // the renderer hydrates from /api/events/snapshot { streamId, sequence }
    const cursor = advanceCursor(INITIAL_CURSOR, { streamId: "ui", sequence: 42 });
    expect(shouldApplyFrame(cursor, frame(42))).toBe(false);
    expect(shouldApplyFrame(cursor, frame(41))).toBe(false);
    expect(shouldApplyFrame(cursor, frame(43))).toBe(true);
  });

  it("a different stream identity resets rather than misfiltering", () => {
    const cursor: SseCursor = { streamId: "ui", sequence: 42 };
    expect(shouldApplyFrame(cursor, frame(1, "ui-v2"))).toBe(true);
    expect(advanceCursor(cursor, frame(1, "ui-v2"))).toEqual({ streamId: "ui-v2", sequence: 1 });
  });

  it("builds the resume URL from the cursor", () => {
    expect(eventsUrl(INITIAL_CURSOR)).toBe("/api/events");
    expect(eventsUrl({ streamId: "ui", sequence: 42 })).toBe("/api/events?lastEventId=42");
  });
});
