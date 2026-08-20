import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CatalogShellView } from "./CatalogShell";
import type { CreationModel } from "./catalog-creation";
import type { CatalogModel } from "./catalog-state";

const HERE = dirname(fileURLToPath(import.meta.url));
const shellSource = readFileSync(join(HERE, "CatalogShell.tsx"), "utf8");
const appSource = readFileSync(join(HERE, "..", "App.tsx"), "utf8");

function markup(model: CatalogModel, creation: CreationModel = { status: "idle" }): string {
  return renderToStaticMarkup(createElement(CatalogShellView, {
    model,
    creation,
    onCreate: vi.fn(),
    onRetryCreation: vi.fn(),
    onRetry: vi.fn(),
    onRequestSignOut: vi.fn(),
    headingRef: createRef<HTMLHeadingElement>(),
    feedbackRef: createRef<HTMLDivElement>(),
    signOutTriggerRef: createRef<HTMLButtonElement>(),
  }));
}

describe("accessible authenticated catalog creation view", () => {
  it("renders deterministic loading, empty, populated, and retryable catalog states", () => {
    const loading = markup({ status: "loading", requestId: 1, items: [] });
    expect(loading).toMatch(/aria-busy="true"[\s\S]*role="status"[\s\S]*aria-live="polite"/);
    expect(loading).toContain("Loading bot catalog");
    expect(loading).toContain('data-saas-progress-indicator="true"');
    expect(loading).not.toContain("Create bot");

    const empty = markup({ status: "empty", requestId: 1, items: [] });
    expect(empty).toMatch(/role="status"[\s\S]*Create your first bot/);
    expect(empty).toContain("Create first bot");

    const populated = markup({
      status: "populated",
      requestId: 1,
      items: [{ name: "Planner", title: "Plans", description: "Safe description", color: "purple" }],
    });
    expect(populated).toContain("VelarixBot SaaS");
    expect(populated).toContain("Bot catalog");
    expect(populated).toMatch(/role="status"[\s\S]*1 bot loaded/);
    expect(populated).toContain("Planner");
    expect(populated).toContain("Create bot");

    const error = markup({ status: "error", requestId: 1, items: [] });
    expect(error).toMatch(/role="alert"[\s\S]*aria-live="assertive"/);
    expect(error).toContain("Try again");
  });

  it("offers accessible creation controls from both empty and populated states and removes read-only copy", () => {
    const empty = markup({ status: "empty", requestId: 1, items: [] });
    expect(empty).toMatch(/<button[^>]*>[\s\S]*?Create bot<\/button>/);
    expect(empty).toContain("Create first bot");
    expect(empty).not.toMatch(/read-only/i);

    const populated = markup({
      status: "populated",
      requestId: 1,
      items: [{ name: "Planner", title: "Plans", description: "Safe", color: "green" }],
    });
    expect(populated).toMatch(/<button[^>]*>[\s\S]*Create bot<\/button>/);
    expect(populated).toContain("Sign out");
  });

  it("disables every create entry point while creation or refetch is pending", () => {
    for (const status of ["creating", "refetching"] as const) {
      const pending = markup({ status: "empty", requestId: 2, items: [] }, { status });
      expect(pending).toContain('aria-busy="true"');
      expect((pending.match(/<button[^>]*disabled=""/g) ?? [])).toHaveLength(2);
      expect(pending).toContain('id="creation-feedback"');
      expect(pending).toContain('role="status"');
      expect(pending).toContain('data-saas-progress-indicator="true"');
    }
  });

  it("announces success, quota, and generic retryable failure with deterministic focus targets", () => {
    const model: CatalogModel = { status: "empty", requestId: 2, items: [] };
    const success = markup(model, { status: "success" });
    expect(success).toMatch(/id="creation-feedback"[\s\S]*tabindex="-1"[\s\S]*role="status"/);
    expect(success).toContain("Bot created. The catalog is up to date.");

    const quota = markup(model, { status: "quota" });
    expect(quota).toMatch(/id="creation-feedback"[\s\S]*role="alert"[\s\S]*aria-live="assertive"/);
    expect(quota).toContain("Bot limit reached");
    expect(quota).not.toMatch(/409|response|server/i);
    expect((quota.match(/<button[^>]*disabled=""/g) ?? [])).toHaveLength(2);

    const failure = markup(model, { status: "failure", retry: "create" });
    expect(failure).toMatch(/role="alert"[\s\S]*We couldn’t finish creating the bot/);
    expect(failure).toContain("Try again");
    expect(shellSource).toContain("feedbackRef.current?.focus()");

    const refreshFailure = markup(model, { status: "failure", retry: "refresh" });
    expect((refreshFailure.match(/<button[^>]*disabled=""/g) ?? [])).toHaveLength(2);
    expect(refreshFailure).toContain("Try again");
  });

  it("renders no protected items after auth loss and preserves sign-out", () => {
    const lost = markup({ status: "auth_lost", requestId: 2, items: [] });
    expect(lost).toContain("Session ended");
    expect(lost).not.toContain("Planner");
    expect(lost).not.toContain("Create bot");

    const empty = markup({ status: "empty", requestId: 1, items: [] });
    expect(empty).toContain("Sign out");
    expect(empty).toMatch(/<h1[^>]*tabindex="-1"[^>]*>Bot catalog<\/h1>/);
  });

  it("keeps the SaaS flow isolated from the desktop store and create modal", () => {
    expect(shellSource).not.toMatch(/StoreProvider|CreateBotModal|state\/store/);
    const saasStart = appSource.indexOf("export function SaasApplication");
    const saasEnd = appSource.indexOf("export function ApplicationRoot", saasStart);
    const saasComposition = appSource.slice(saasStart, saasEnd);
    expect(saasComposition).toContain("<SessionBoundary");
    expect(saasComposition).toContain("<CatalogShell");
    expect(saasComposition).not.toMatch(/StoreProvider|CreateBotModal|DesktopApplication/);
  });
});
