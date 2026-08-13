import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import {
  DISTILL_MARKER,
  botMemoryPath,
  capMemory,
  distillMemory,
  joinMemory,
  memoryPrompt,
  readBotMemory,
  splitMemory,
  turnTextFromMessages,
  workspacePath,
  writeBotMemory,
} from "./memory.ts";

const BOT = "bot-memory-1";

beforeEach(() => {
  mkdirSync(join(DATA_DIR, "memory"), { recursive: true });
  writeFileSync(workspacePath(), "");
  writeFileSync(botMemoryPath(BOT), "");
});

describe("memory files", () => {
  it("splits user notes from distilled notes at the marker", () => {
    const raw = `Keep my timezone.\n\n${DISTILL_MARKER}\nLikes short answers.\n`;
    expect(splitMemory(raw)).toEqual({ user: "Keep my timezone.\n\n", distilled: "\nLikes short answers.\n" });
    expect(joinMemory("Keep my timezone.", "Likes short answers.")).toContain("Keep my timezone.");
    expect(joinMemory("Keep my timezone.", "Likes short answers.")).toContain(DISTILL_MARKER);
  });

  it("injects workspace.md and the per-bot file into startTurn, capped", () => {
    writeFileSync(workspacePath(), "Team ships on Fridays.");
    writeBotMemory(BOT, { user: "Call me Sam.", distilled: "Prefers bullet lists." });
    const prompt = memoryPrompt(BOT);
    expect(prompt).toContain("Team ships on Fridays.");
    expect(prompt).toContain("Call me Sam.");
    expect(prompt).toContain("Prefers bullet lists.");

    writeFileSync(workspacePath(), "W".repeat(20_000));
    expect(memoryPrompt(BOT).includes("W".repeat(20_000))).toBe(false);
    expect(capMemory("x".repeat(10)).length).toBe(10);
  });

  it("distills below the marker and preserves the user section", async () => {
    writeBotMemory(BOT, { user: "Never change this.", distilled: "old note" });
    await distillMemory({
      botId: BOT,
      turnText: "User: I moved to Austin.\n\nBot: Got it.",
      generateText: async () => "Lives in Austin.",
    });
    const after = readBotMemory(BOT);
    expect(after.user).toContain("Never change this.");
    expect(after.distilled).toContain("Lives in Austin.");
    expect(after.distilled).not.toContain("old note");
  });

  it("skips distill when there is no generateText hook, and a thrown hook does not fail the turn", async () => {
    writeBotMemory(BOT, { user: "Stay.", distilled: "" });
    await expect(distillMemory({ botId: BOT, turnText: "hello" })).resolves.toBeUndefined();
    expect(readBotMemory(BOT).user).toContain("Stay.");
    expect(readBotMemory(BOT).distilled).toBe("");

    await expect(
      distillMemory({
        botId: BOT,
        turnText: "hello",
        generateText: async () => {
          throw new Error("haiku down");
        },
      }),
    ).resolves.toBeUndefined();
    expect(readBotMemory(BOT).user).toContain("Stay.");
  });

  it("builds turn text from settled messages", () => {
    expect(
      turnTextFromMessages([
        { role: "user", kind: "text", text: "hi" },
        { role: "bot", kind: "activity", text: "tool" },
        { role: "bot", kind: "text", text: "hello" },
      ]),
    ).toBe("User: hi\n\nBot: hello");
  });
});
