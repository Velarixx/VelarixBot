import { describe, expect, it } from "vitest";
import {
  INITIAL_SESSION_MODEL,
  SESSION_STATUSES,
  createAttemptGuard,
  modelForReturnedOutcome,
  sessionReducer,
  type SessionAction,
  type SessionModel,
} from "./session-state";

describe("session state machine", () => {
  it("declares every DHV-28 semantic state exactly once", () => {
    expect(SESSION_STATUSES).toEqual([
      "session_checking",
      "sign_in_required",
      "sign_in_pending",
      "sign_in_declined",
      "callback_rejected",
      "session_ended",
      "service_unavailable",
      "authenticated",
      "sign_out_confirm",
      "sign_out_pending",
      "signed_out",
      "sign_out_unconfirmed",
    ]);
    expect(new Set(SESSION_STATUSES).size).toBe(12);
  });

  it("does not trust a callback success before the session probe", () => {
    expect(modelForReturnedOutcome("authenticated")).toEqual(INITIAL_SESSION_MODEL);
    expect(modelForReturnedOutcome("none")).toEqual(INITIAL_SESSION_MODEL);
    expect(modelForReturnedOutcome("sign_in_declined").status).toBe("sign_in_declined");
    expect(modelForReturnedOutcome("callback_rejected").status).toBe("callback_rejected");
    expect(modelForReturnedOutcome("service_unavailable")).toEqual({
      status: "service_unavailable",
      wasAuthenticated: false,
      manualAttempt: true,
    });
  });

  it("reaches every state through explicit fail-closed transitions", () => {
    const authenticated = sessionReducer(INITIAL_SESSION_MODEL, { type: "check_authenticated" });
    const transitions: Array<[SessionModel, SessionAction]> = [
      [INITIAL_SESSION_MODEL, { type: "check_requested", manual: true }],
      [INITIAL_SESSION_MODEL, { type: "check_unauthenticated" }],
      [INITIAL_SESSION_MODEL, { type: "sign_in_started" }],
      [INITIAL_SESSION_MODEL, { type: "sign_in_declined" }],
      [INITIAL_SESSION_MODEL, { type: "callback_rejected" }],
      [authenticated, { type: "check_unauthenticated" }],
      [INITIAL_SESSION_MODEL, { type: "check_unavailable" }],
      [INITIAL_SESSION_MODEL, { type: "check_authenticated" }],
      [authenticated, { type: "sign_out_requested" }],
      [{ ...authenticated, status: "sign_out_confirm" }, { type: "sign_out_confirmed" }],
      [{ status: "sign_out_pending", wasAuthenticated: false, manualAttempt: false }, { type: "sign_out_succeeded" }],
      [{ status: "sign_out_pending", wasAuthenticated: false, manualAttempt: false }, { type: "sign_out_failed" }],
    ];
    expect(transitions.map(([model, action]) => sessionReducer(model, action).status)).toEqual(SESSION_STATUSES);
  });

  it("clears authenticated context before sign-out transport resolves", () => {
    const pending = sessionReducer(
      { status: "sign_out_confirm", wasAuthenticated: true, manualAttempt: false },
      { type: "sign_out_confirmed" },
    );
    expect(pending).toEqual({ status: "sign_out_pending", wasAuthenticated: false, manualAttempt: false });
    expect(sessionReducer(pending, { type: "sign_out_failed" })).toEqual({
      status: "sign_out_unconfirmed",
      wasAuthenticated: false,
      manualAttempt: true,
    });
  });

  it("cannot manufacture authenticated state from invalid actions or invalid sign-out entry", () => {
    expect(sessionReducer(INITIAL_SESSION_MODEL, { type: "sign_out_requested" }).status).toBe("service_unavailable");
    expect(sessionReducer(INITIAL_SESSION_MODEL, { type: "unknown" } as never)).toEqual({
      status: "service_unavailable",
      wasAuthenticated: false,
      manualAttempt: true,
    });
  });

  it("guards provider launch and sign-out against duplicate attempts", () => {
    const guard = createAttemptGuard();
    expect(guard.tryStart()).toBe(true);
    expect(guard.tryStart()).toBe(false);
    guard.reset();
    expect(guard.tryStart()).toBe(true);
  });

  it("marks user-submitted probe and provider failures for alert semantics", () => {
    const manualCheck = sessionReducer(INITIAL_SESSION_MODEL, { type: "check_requested", manual: true });
    expect(sessionReducer(manualCheck, { type: "check_unavailable" }).manualAttempt).toBe(true);
    const providerPending = sessionReducer(INITIAL_SESSION_MODEL, { type: "sign_in_started" });
    expect(sessionReducer(providerPending, { type: "check_unavailable" }).manualAttempt).toBe(true);
  });
});
