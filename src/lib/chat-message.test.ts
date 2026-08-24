import { describe, expect, it } from "vitest";

import {
  ACTIVITY_STATUS_LABEL,
  activityStatusOf,
  attachmentDisplayName,
  commandNeedsExpand,
  commandLabel,
  isActivityRunning,
  redactCommand,
  splitAttachedFiles,
  visibleCommand,
} from "./chat-message";

const LONG_PATH =
  "/Users/dkarijopawiro/Downloads/Hermes_NSX_Security_Explorer_Project_Instructions_FINAL_REVIEWED.md";

describe("user attachment paths", () => {
  it("splits the attached-files block from a user message", () => {
    const winPath = "C:\\docs\\notes.md";
    const text = `please review\n\nAttached files:\n- ${LONG_PATH}\n- ${winPath}`;
    const { body, paths } = splitAttachedFiles(text);
    expect(body).toBe("please review");
    expect(paths).toEqual([LONG_PATH, winPath]);
    expect(attachmentDisplayName(LONG_PATH)).toBe(
      "Hermes_NSX_Security_Explorer_Project_Instructions_FINAL_REVIEWED.md",
    );
    expect(attachmentDisplayName(winPath)).toBe("notes.md");
  });

  it("leaves ordinary user text alone", () => {
    expect(splitAttachedFiles("hello\nworld")).toEqual({ body: "hello\nworld", paths: [] });
  });
});

describe("command activity display", () => {
  it("keeps secrets redacted in both the collapsed label and the full command", () => {
    const tool = {
      name: "curl -H token=[redacted] https://example.test",
      command: "curl -H token=sk-live-supersecret https://example.test\n--data ok",
    };
    expect(visibleCommand(tool)).not.toContain("sk-live-supersecret");
    expect(visibleCommand(tool)).toContain("[redacted]");
    expect(commandLabel(tool)).not.toContain("sk-live-supersecret");
    expect(commandNeedsExpand(tool)).toBe(true);
    expect(redactCommand("password=hunter2")).toContain("[redacted]");
  });

  it("does not offer expand for a short single-line command", () => {
    expect(commandNeedsExpand({ name: "ls -la" })).toBe(false);
  });

  it("maps running and each terminal status", () => {
    expect(activityStatusOf({ name: "run" })).toBe("running");
    expect(isActivityRunning({ name: "run", ok: undefined })).toBe(true);
    expect(activityStatusOf({ name: "run", ok: true })).toBe("completed");
    expect(activityStatusOf({ name: "run", ok: false })).toBe("failed");
    expect(activityStatusOf({ name: "run", status: "cancelled" })).toBe("cancelled");
    expect(activityStatusOf({ name: "run", status: "timed_out", ok: false })).toBe("timed_out");
    expect(ACTIVITY_STATUS_LABEL.timed_out).toBe("Timed out");
  });
});
