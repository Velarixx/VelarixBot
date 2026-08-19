import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { ApplicationRoot, DesktopApplication, InvalidApplicationMode } from "@/App";
import { SessionBoundary, SessionBoundaryView, type SessionBoundaryActions } from "./SessionBoundary";
import { SESSION_STATUSES, type SessionModel, type SessionStatus } from "./session-state";

const HERE = dirname(fileURLToPath(import.meta.url));
const boundarySource = readFileSync(join(HERE, "SessionBoundary.tsx"), "utf8");
const transportSource = readFileSync(join(HERE, "session-transport.ts"), "utf8");
const appSource = readFileSync(join(HERE, "..", "App.tsx"), "utf8");

const actions: SessionBoundaryActions = {
  checkSession: vi.fn(),
  beginSignIn: vi.fn(),
  cancelSignIn: vi.fn(),
  requestSignOut: vi.fn(),
  cancelSignOut: vi.fn(),
  confirmSignOut: vi.fn(),
};

function markup(status: SessionStatus, overrides: Partial<SessionModel> = {}): string {
  return renderToStaticMarkup(createElement(SessionBoundaryView, {
    model: { status, wasAuthenticated: status === "authenticated", manualAttempt: false, ...overrides },
    actions,
  }));
}

describe("accessible fail-closed session boundary", () => {
  it("renders every DHV-28 state inside the dedicated boundary", () => {
    for (const status of SESSION_STATUSES) {
      const html = markup(status);
      expect(html).toContain('data-session-boundary="true"');
      expect(html).toContain("<h1");
      expect(html).not.toContain("No bots yet");
      expect(html).not.toContain("Create a bot");
    }
  });

  it("uses status, alert, busy, focus, and dialog semantics at their owning scope", () => {
    expect(markup("session_checking")).toMatch(/aria-busy="true"[\s\S]*role="status"[\s\S]*aria-live="polite"/);
    expect(markup("sign_in_declined")).toContain('role="alert"');
    expect(markup("callback_rejected")).toContain('role="alert"');
    expect(markup("session_ended")).toContain('role="alert"');
    expect(markup("service_unavailable", { manualAttempt: false })).toContain('role="status"');
    expect(markup("service_unavailable", { manualAttempt: true })).toContain('role="alert"');
    expect(markup("sign_out_confirm")).toMatch(/role="dialog"[\s\S]*aria-modal="true"/);
    expect(markup("sign_out_pending")).toMatch(/role="dialog"[\s\S]*aria-busy="true"/);
    expect(markup("sign_in_required")).toContain('tabindex="-1"');
  });

  it("offers only safe actions for ended and sign-out states", () => {
    expect(markup("session_ended")).toContain("Sign in again");
    expect(markup("sign_out_confirm")).toContain("Cancel");
    expect(markup("sign_out_confirm")).toContain("Sign out");
    expect(markup("sign_out_pending")).not.toContain("<button");
    const unconfirmed = markup("sign_out_unconfirmed");
    expect(unconfirmed).toContain("Try sign-out again");
    expect(unconfirmed).toContain("close this window");
    expect(unconfirmed).not.toMatch(/Sign in again|switch account/i);
  });

  it("renders no raw server, provider, token, cookie, UUID, or error detail", () => {
    const allMarkup = SESSION_STATUSES.map((status) => markup(status)).join("\n");
    expect(allMarkup).not.toMatch(/123e4567|provider-secret|oauth[_ -]?code|access[_ -]?token|velarix_session|stack trace|error\.message/i);
    expect(boundarySource).not.toMatch(/console\.|\.message\b|localStorage|document\.cookie/);
  });

  it("scrubs returned results during state initialization and guards duplicate actions", () => {
    expect(boundarySource).toContain("useState(() =>");
    expect(boundarySource).toContain("consumeAuthorizationResult(window.location, window.history)");
    expect(boundarySource).toContain("signInGuard.current.tryStart()");
    expect(boundarySource).toContain("signOutGuard.current.tryStart()");
    expect(boundarySource).toContain("probeGuard.current.tryStart()");
    expect(boundarySource).toContain('event.key === "Escape"');
    expect(boundarySource).toContain('event.key !== "Tab"');
  });

  it("keeps SaaS and invalid roots structurally outside StoreProvider and Shell", () => {
    expect(ApplicationRoot({ mode: "saas" }).type).toBe(SessionBoundary);
    expect(ApplicationRoot({ mode: "invalid" }).type).toBe(InvalidApplicationMode);
    expect(ApplicationRoot({ mode: "desktop" }).type).toBe(DesktopApplication);
    expect(boundarySource).not.toMatch(/StoreProvider|<Shell|useStore/);
    expect(appSource).toContain("<StoreProvider>");
    expect(appSource).toContain("Connection lost. Reconnecting");
  });

  it("contains no product request path in the boundary transport", () => {
    expect(transportSource).toContain('"/api/session"');
    expect(transportSource).toContain('"/api/auth/github/start"');
    expect(transportSource).toContain('"/api/auth/sign-out"');
    expect(transportSource).not.toMatch(/\/api\/(?:events|bots|groups|routines|approvals|computers|workspaces|instances|config)/);
    expect(boundarySource).not.toMatch(/fetch\(|EventSource|\/api\//);
  });
});
