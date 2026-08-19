export const SESSION_STATUSES = [
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
] as const;

export type SessionStatus = (typeof SESSION_STATUSES)[number];

export interface SessionModel {
  status: SessionStatus;
  /** Local control bit only. No identity or provider data is retained. */
  wasAuthenticated: boolean;
  /** Allows a submitted retry failure to use urgent alert semantics. */
  manualAttempt: boolean;
}

export type SessionAction =
  | { type: "check_requested"; manual: boolean }
  | { type: "check_authenticated" }
  | { type: "check_unauthenticated" }
  | { type: "check_unavailable" }
  | { type: "sign_in_started" }
  | { type: "sign_in_cancelled" }
  | { type: "sign_in_declined" }
  | { type: "callback_rejected" }
  | { type: "sign_out_requested" }
  | { type: "sign_out_cancelled" }
  | { type: "sign_out_confirmed" }
  | { type: "sign_out_succeeded" }
  | { type: "sign_out_failed" };

export const INITIAL_SESSION_MODEL: SessionModel = {
  status: "session_checking",
  wasAuthenticated: false,
  manualAttempt: false,
};

export function modelForReturnedOutcome(
  outcome: "none" | "authenticated" | "sign_in_declined" | "callback_rejected" | "service_unavailable",
): SessionModel {
  if (outcome === "sign_in_declined") {
    return { status: "sign_in_declined", wasAuthenticated: false, manualAttempt: false };
  }
  if (outcome === "callback_rejected") {
    return { status: "callback_rejected", wasAuthenticated: false, manualAttempt: false };
  }
  if (outcome === "service_unavailable") {
    // This outcome returns from an explicit provider handoff, so it owns
    // submitted-error alert and focus semantics rather than background status.
    return { status: "service_unavailable", wasAuthenticated: false, manualAttempt: true };
  }
  // Even the reviewed "authenticated" callback must be proved by a fresh,
  // allowlisted session probe before the client can enter authenticated.
  return INITIAL_SESSION_MODEL;
}

export function sessionReducer(model: SessionModel, action: SessionAction): SessionModel {
  switch (action.type) {
    case "check_requested":
      return { ...model, status: "session_checking", manualAttempt: action.manual };
    case "check_authenticated":
      return { status: "authenticated", wasAuthenticated: true, manualAttempt: false };
    case "check_unauthenticated":
      return {
        status: model.wasAuthenticated ? "session_ended" : "sign_in_required",
        wasAuthenticated: false,
        manualAttempt: false,
      };
    case "check_unavailable":
      return {
        ...model,
        status: "service_unavailable",
        manualAttempt: model.manualAttempt || model.status === "sign_in_pending",
      };
    case "sign_in_started":
      return { ...model, status: "sign_in_pending", manualAttempt: false };
    case "sign_in_cancelled":
      return { status: "sign_in_required", wasAuthenticated: false, manualAttempt: false };
    case "sign_in_declined":
      return { status: "sign_in_declined", wasAuthenticated: false, manualAttempt: false };
    case "callback_rejected":
      return { status: "callback_rejected", wasAuthenticated: false, manualAttempt: false };
    case "sign_out_requested":
      return model.wasAuthenticated
        ? { ...model, status: "sign_out_confirm", manualAttempt: false }
        : { status: "service_unavailable", wasAuthenticated: false, manualAttempt: true };
    case "sign_out_cancelled":
      return model.wasAuthenticated
        ? { status: "authenticated", wasAuthenticated: true, manualAttempt: false }
        : { status: "service_unavailable", wasAuthenticated: false, manualAttempt: true };
    case "sign_out_confirmed":
      // Clear the only protected client marker before transport begins. The
      // SaaS root never mounts product/store state in this slice.
      return { status: "sign_out_pending", wasAuthenticated: false, manualAttempt: false };
    case "sign_out_succeeded":
      return { status: "signed_out", wasAuthenticated: false, manualAttempt: false };
    case "sign_out_failed":
      return { status: "sign_out_unconfirmed", wasAuthenticated: false, manualAttempt: true };
    default:
      // Runtime callers cannot turn an unrecognized event into access.
      return { status: "service_unavailable", wasAuthenticated: false, manualAttempt: true };
  }
}

export interface AttemptGuard {
  tryStart(): boolean;
  reset(): void;
}

export function createAttemptGuard(): AttemptGuard {
  let active = false;
  return {
    tryStart() {
      if (active) return false;
      active = true;
      return true;
    },
    reset() {
      active = false;
    },
  };
}
