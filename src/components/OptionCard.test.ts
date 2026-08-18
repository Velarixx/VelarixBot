import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const card = readFileSync(join(HERE, "OptionCard.tsx"), "utf8");
const store = readFileSync(join(HERE, "..", "state", "store.tsx"), "utf8");

describe("inline request-card recovery", () => {
  it("announces submission and prevents duplicate responses while pending", () => {
    expect(card).toContain("if (submittingRef.current) return;");
    expect(card).toContain("submittingRef.current = true;");
    expect(card).toContain('aria-busy={submitting}');
    expect(card).toContain('role="status" aria-live="polite"');
    expect(card).toContain("Submitting response…");
    expect(card).toContain("disabled={submitting || !!card.answered}");
    expect(card).toContain("disabled={submitting}");

    const liveAnswer = store.slice(
      store.indexOf('if (action.type === "answerCard")'),
      store.indexOf('if (action.type === "dismissCard")'),
    );
    expect(liveAnswer.indexOf(".then(() => {")).toBeLessThan(liveAnswer.indexOf("rawDispatch(action)"));
  });

  it("keeps a failed response in the card and offers an inline retry", () => {
    expect(card).toContain("setRetainedResponse(response)");
    expect(card).toContain("setResponseError(error)");
    expect(card).toContain('role="alert"');
    expect(card).toContain("Couldn’t send your response.");
    expect(card).toContain("Retry response");
    expect(card).toContain("submitResponse(retainedResponse)");
    expect(store).toContain("const message = showError(error)");
    expect(store).toContain("action.onError?.(message)");
  });

  it("retains typed secrets and selected answers until a live response succeeds", () => {
    expect(card).toContain("retainedResponse?.answer === opt");
    const liveRequest = card.slice(card.indexOf("setSubmitting(true)"), card.indexOf("return ("));
    const success = liveRequest.indexOf("const onSuccess");
    const clearSecret = liveRequest.indexOf('if (response.secret) setCustom("")', success);
    const failure = liveRequest.indexOf("const onError");
    expect(clearSecret).toBeGreaterThan(success);
    expect(clearSecret).toBeLessThan(failure);
    expect(liveRequest.slice(failure)).not.toContain('setCustom("")');
  });

  it("names dismiss controls and preserves allow, deny, and scope semantics", () => {
    expect(card).toContain('"Deny and dismiss request"');
    expect(card).toContain('"Dismiss card"');
    expect(card).toContain('<X size={16} aria-hidden="true" />');
    expect(card).toContain('answer("Allow once", { always: true })');
    expect(card).toContain('persistScope: "workspace"');
    expect(store).toContain('behavior: "deny", message: "Dismissed by user."');
    expect(store).toContain('persistScope: action.persistScope ?? "bot"');
  });
});
