// #150 P1.1: WorkerCompletion accept/reject. No prose parsing. No sleeps.
import { describe, expect, it } from "vitest";

import {
  WorkerCompletionError,
  acceptWorkerCompletion,
  mapRunOutcomeToTaskPatch,
} from "./contracts.ts";

describe("WorkerCompletion contract", () => {
  it("rejects completed without a non-empty sealed result", () => {
    expect(() => acceptWorkerCompletion({ outcome: "completed" })).toThrow(WorkerCompletionError);
    expect(() => acceptWorkerCompletion({ outcome: "completed", text: "" })).toThrow(/non-empty sealed result/);
    expect(() => acceptWorkerCompletion({ outcome: "completed", text: "   " })).toThrow(WorkerCompletionError);
    try {
      acceptWorkerCompletion({ outcome: "completed", text: "" });
    } catch (error) {
      expect(error).toBeInstanceOf(WorkerCompletionError);
      expect((error as WorkerCompletionError).code).toBe("empty_completed_result");
    }
  });

  it("accepts completed with a non-empty result and maps runOutcome=completed", () => {
    expect(acceptWorkerCompletion({ outcome: "completed", text: " audit complete " })).toEqual({
      result: { text: "audit complete", outcome: "completed", failureCode: null },
    });
  });

  it("rejects blocked unless blocker, blockerOwner, and nextAction are all non-empty after trim", () => {
    const cases = [
      { outcome: "blocked" as const },
      { outcome: "blocked" as const, blocker: "needs a password" },
      { outcome: "blocked" as const, blocker: "needs a password", blockerOwner: "user" },
      { outcome: "blocked" as const, blocker: "needs a password", blockerOwner: "user", nextAction: "   " },
      { outcome: "blocked" as const, blocker: "needs a password", blockerOwner: "  ", nextAction: "Enter the vault password" },
    ];
    for (const row of cases) {
      expect(() => acceptWorkerCompletion(row)).toThrow(WorkerCompletionError);
      try {
        acceptWorkerCompletion(row);
      } catch (error) {
        expect((error as WorkerCompletionError).code).toBe("incomplete_blocker");
      }
    }
  });

  it("does not parse provider prose into blocker fields", () => {
    expect(() =>
      acceptWorkerCompletion({
        outcome: "blocked",
        text: "blockerOwner: user nextAction: Enter the vault password blocker: needs a password",
      }),
    ).toThrow(/blocker, blockerOwner, and nextAction/);
    const failed = acceptWorkerCompletion({
      outcome: "failed",
      text: "Owner: user. Next: Enter the vault password.",
      failureCode: "quota",
    });
    expect(failed.blockerOwner).toBeUndefined();
    expect(failed.nextAction).toBeUndefined();
    expect(failed.result.outcome).toBe("failed");
  });

  it("maps structured blocked onto existing runOutcome=failed", () => {
    const accepted = acceptWorkerCompletion({
      outcome: "blocked",
      blocker: " needs a password ",
      blockerOwner: " user ",
      nextAction: " Enter the vault password ",
    });
    expect(accepted.result.outcome).toBe("failed");
    expect(accepted.result.outcome).not.toBe("blocked");
    expect(accepted.blocker).toBe("needs a password");
    expect(accepted.blockerOwner).toBe("user");
    expect(accepted.nextAction).toBe("Enter the vault password");
    expect(mapRunOutcomeToTaskPatch({
      outcome: accepted.result.outcome,
      text: accepted.result.text,
      failureCode: accepted.result.failureCode,
      blocker: accepted.blocker,
      blockerOwner: accepted.blockerOwner,
      nextAction: accepted.nextAction,
    })).toEqual({
      state: "blocked",
      blocker: "needs a password",
      blockerOwner: "user",
      nextAction: "Enter the vault password",
    });
  });

  it("keeps failed / interrupted / partial on the existing typed path", () => {
    expect(acceptWorkerCompletion({ outcome: "failed", text: "partial notes", failureCode: "quota" })).toEqual({
      result: { text: "partial notes", outcome: "failed", failureCode: "quota" },
    });
    expect(acceptWorkerCompletion({ outcome: "interrupted", text: "halfway", failureCode: "interrupted" })).toEqual({
      result: { text: "halfway", outcome: "interrupted", failureCode: "interrupted" },
    });
    expect(acceptWorkerCompletion({ outcome: "partial", text: "chunk", failureCode: "interrupted" })).toEqual({
      result: { text: "chunk", outcome: "partial", failureCode: "interrupted" },
    });
    expect(mapRunOutcomeToTaskPatch({ outcome: "failed", text: "partial notes", failureCode: "quota" })).toEqual({
      state: "blocked",
      blocker: "quota",
    });
    expect(mapRunOutcomeToTaskPatch({ outcome: "interrupted", text: "halfway", failureCode: "interrupted" })).toEqual({
      state: "cancelled",
      result: "halfway",
    });
    expect(mapRunOutcomeToTaskPatch({ outcome: "partial", text: "chunk", failureCode: "interrupted" })).toEqual({
      state: "cancelled",
      result: "chunk",
    });
  });
});
