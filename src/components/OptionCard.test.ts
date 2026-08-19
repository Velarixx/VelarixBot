import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  approvalResponse,
  OptionCard,
  OptionCardFeedback,
  submitCardResponse,
  type CardDispatchAction,
  type CardResponse,
} from "./OptionCard";
import { StoreProvider, type Message } from "../state/store";

function submissionHarness(response: CardResponse) {
  const actions: CardDispatchAction[] = [];
  const submitting = { current: false };
  const submittingStates: boolean[] = [];
  const errors: Array<string | null> = [];
  const retained: Array<CardResponse | null> = [];
  let clearedSecrets = 0;

  const submit = () => submitCardResponse({
    botId: "bot-1",
    messageId: "message-1",
    liveRequest: true,
    response,
    submitting,
    dispatch: (action) => actions.push(action),
    setSubmitting: (value) => submittingStates.push(value),
    setResponseError: (value) => errors.push(value),
    setRetainedResponse: (value) => retained.push(value),
    clearSecret: () => { clearedSecrets += 1; },
  });

  return {
    actions,
    submitting,
    submittingStates,
    errors,
    retained,
    submit,
    clearedSecrets: () => clearedSecrets,
  };
}

describe("approval-card contract", () => {
  it("builds the exact once, bot, and workspace approval payloads", () => {
    expect(approvalResponse("once")).toStrictEqual({ answer: "Allow once" });
    expect(approvalResponse("bot")).toStrictEqual({ answer: "Allow once", always: true });
    expect(approvalResponse("workspace")).toStrictEqual({
      answer: "Allow once",
      always: true,
      persistScope: "workspace",
    });
  });

  it("submits once while pending, retains a failure, and retries the same payload", () => {
    const response = approvalResponse("workspace");
    const harness = submissionHarness(response);

    expect(harness.submit()).toBe(true);
    expect(harness.submit()).toBe(false);
    expect(harness.actions).toHaveLength(1);
    expect(harness.actions[0]).toMatchObject({
      type: "answerCard",
      botId: "bot-1",
      messageId: "message-1",
      ...response,
    });
    expect(harness.submittingStates).toEqual([true]);
    expect(harness.retained).toEqual([response]);

    harness.actions[0]?.onError?.("Approval service unavailable");
    expect(harness.submitting.current).toBe(false);
    expect(harness.submittingStates).toEqual([true, false]);
    expect(harness.errors.at(-1)).toBe("Approval service unavailable");
    expect(harness.retained.at(-1)).toBe(response);

    expect(harness.submit()).toBe(true);
    expect(harness.actions).toHaveLength(2);
    expect(harness.actions[1]).toMatchObject({ type: "answerCard", ...response });
    harness.actions[1]?.onSuccess?.();
    expect(harness.errors.at(-1)).toBeNull();
    expect(harness.retained.at(-1)).toBeNull();
  });

  it("keeps deny as an answer and dismiss as the explicit deny-and-dismiss action", () => {
    const actions: CardDispatchAction[] = [];
    const common = {
      botId: "bot-1",
      messageId: "message-1",
      liveRequest: false,
      submitting: { current: false },
      dispatch: (action: CardDispatchAction) => actions.push(action),
      setSubmitting: () => undefined,
      setResponseError: () => undefined,
      setRetainedResponse: () => undefined,
      clearSecret: () => undefined,
    };

    submitCardResponse({ ...common, response: { answer: "Deny" } });
    submitCardResponse({ ...common, response: { answer: "Dismissed", dismiss: true } });

    expect(actions[0]).toStrictEqual({
      type: "answerCard",
      botId: "bot-1",
      messageId: "message-1",
      answer: "Deny",
    });
    expect(actions[1]).toStrictEqual({
      type: "dismissCard",
      botId: "bot-1",
      messageId: "message-1",
    });
  });

  it("renders a labelled approval group with one Allow once and a named dismiss control", () => {
    const message: Message = {
      id: "message-1",
      role: "bot",
      kind: "options",
      at: 1,
      card: {
        title: "Approval needed",
        subtitle: "Run the requested tool?",
        options: ["Allow once", "Deny"],
        requestId: "request-1",
        requestType: "permission",
      },
    };
    const markup = renderToStaticMarkup(
      createElement(StoreProvider, null, createElement(OptionCard, { botId: "bot-1", message })),
    );

    expect(markup).toContain('role="group"');
    expect(markup).toContain('aria-labelledby=');
    expect(markup).toContain('aria-label="Deny and dismiss request"');
    expect(markup).toContain('aria-hidden="true"');
    expect(markup.match(/Allow once/g)).toHaveLength(1);
    expect(markup).toContain("Always allow for this bot");
    expect(markup).toContain("Advanced: always allow for all bots");
  });

  it("renders pending and retry feedback as announced status and alert regions", () => {
    const pending = renderToStaticMarkup(createElement(OptionCardFeedback, {
      submitting: true,
      responseError: null,
    }));
    expect(pending).toContain('role="status"');
    expect(pending).toContain('aria-live="polite"');
    expect(pending).toContain("Submitting response…");

    const failed = renderToStaticMarkup(createElement(OptionCardFeedback, {
      submitting: false,
      responseError: "Approval service unavailable",
      onRetry: () => undefined,
    }));
    expect(failed).toContain('role="alert"');
    expect(failed).toContain("Approval service unavailable");
    expect(failed).toContain("Retry response");
  });
});
