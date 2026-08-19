import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CatalogShellView } from "./CatalogShell";
import type { CatalogModel } from "./catalog-state";

function markup(model: CatalogModel): string {
  return renderToStaticMarkup(createElement(CatalogShellView, {
    model,
    onRetry: vi.fn(),
    onRequestSignOut: vi.fn(),
    headingRef: createRef<HTMLHeadingElement>(),
    signOutTriggerRef: createRef<HTMLButtonElement>(),
  }));
}

describe("accessible read-only catalog view", () => {
  it("renders deterministic loading, empty, populated, and retryable error states", () => {
    const loading = markup({ status: "loading", requestId: 1, items: [] });
    expect(loading).toMatch(/aria-busy="true"[\s\S]*role="status"[\s\S]*aria-live="polite"/);
    expect(loading).toContain("Loading bot catalog");

    const empty = markup({ status: "empty", requestId: 1, items: [] });
    expect(empty).toMatch(/role="status"[\s\S]*No bots available/);

    const populated = markup({
      status: "populated",
      requestId: 1,
      items: [{ name: "Planner", title: "Plans", description: "Safe description", color: "purple" }],
    });
    expect(populated).toContain("VelarixBot SaaS");
    expect(populated).toContain("Bot catalog");
    expect(populated).toMatch(/role="status"[\s\S]*1 bot loaded/);
    expect(populated).toContain("Planner");

    const error = markup({ status: "error", requestId: 1, items: [] });
    expect(error).toMatch(/role="alert"[\s\S]*aria-live="assertive"/);
    expect(error).toContain("Try again");
  });

  it("renders no protected items after auth loss and exposes no write action", () => {
    const lost = markup({ status: "auth_lost", requestId: 2, items: [] });
    expect(lost).toContain("Session ended");
    expect(lost).not.toContain("Planner");

    const all = [
      markup({ status: "loading", requestId: 1, items: [] }),
      markup({ status: "empty", requestId: 1, items: [] }),
      markup({ status: "error", requestId: 1, items: [] }),
    ].join("\n");
    expect(all).not.toMatch(/create|edit|delete|chat|send/i);
  });

  it("gives the result heading a focus target and keeps announcements scoped", () => {
    const empty = markup({ status: "empty", requestId: 1, items: [] });
    expect(empty).toMatch(/<h1[^>]*tabindex="-1"[^>]*>Bot catalog<\/h1>/);
    expect((empty.match(/aria-live="polite"/g) ?? [])).toHaveLength(1);
  });
});
