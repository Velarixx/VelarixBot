import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { Message } from "@/state/store";
import { ActivityChipView } from "./ActivityChip";

function activity(tool: Message["tool"]): Message {
  return { id: "a1", role: "bot", kind: "activity", at: 1, tool };
}

describe("ActivityChip", () => {
  it("shows a spinner only while the activity is still running", () => {
    const markup = renderToStaticMarkup(
      createElement(ActivityChipView, { message: activity({ name: "run" }), expanded: false }),
    );
    expect(markup).toContain("aria-label=\"Running\"");
    expect(markup).toContain("animate-spin");
    expect(markup).not.toContain("Show full command");
  });

  it("renders distinct terminal states for completed, failed, cancelled, and timed out", () => {
    const completed = renderToStaticMarkup(
      createElement(ActivityChipView, {
        message: activity({ name: "run", ok: true, status: "completed" }),
        expanded: false,
      }),
    );
    const failed = renderToStaticMarkup(
      createElement(ActivityChipView, {
        message: activity({ name: "run", ok: false, status: "failed" }),
        expanded: false,
      }),
    );
    const cancelled = renderToStaticMarkup(
      createElement(ActivityChipView, {
        message: activity({ name: "run", ok: false, status: "cancelled" }),
        expanded: false,
      }),
    );
    const timedOut = renderToStaticMarkup(
      createElement(ActivityChipView, {
        message: activity({ name: "run", ok: false, status: "timed_out" }),
        expanded: false,
      }),
    );
    expect(completed).toContain("aria-label=\"Completed\"");
    expect(completed).not.toContain("animate-spin");
    expect(failed).toContain("aria-label=\"Failed\"");
    expect(cancelled).toContain("aria-label=\"Cancelled\"");
    expect(timedOut).toContain("aria-label=\"Timed out\"");
  });

  it("offers expand, preserves line breaks, supports copy, and stays redacted", () => {
    const tool = {
      name: "curl -H token=[redacted] https://example.test",
      command: "curl -H token=sk-live-supersecret https://example.test\n--data ok",
      ok: true,
      status: "completed" as const,
    };
    const collapsed = renderToStaticMarkup(
      createElement(ActivityChipView, { message: activity(tool), expanded: false }),
    );
    expect(collapsed).toContain("Show full command");
    expect(collapsed).toContain("aria-expanded=\"false\"");
    expect(collapsed).not.toContain("sk-live-supersecret");

    const expanded = renderToStaticMarkup(
      createElement(ActivityChipView, { message: activity(tool), expanded: true }),
    );
    expect(expanded).toContain("Collapse");
    expect(expanded).toContain("Copy");
    expect(expanded).toContain("whitespace-pre-wrap");
    expect(expanded).toContain("--data ok");
    expect(expanded).not.toContain("sk-live-supersecret");
    expect(expanded).toContain("[redacted]");
  });
});
