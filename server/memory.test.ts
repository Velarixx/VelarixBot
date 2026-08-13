import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import {
  DISTILL_MARKER,
  botMemoryPath,
  capMemory,
  distillMemory,
  fleetGenerateText,
  joinMemory,
  memoryPrompt,
  readBotMemory,
  readWorkspace,
  recallMemory,
  rememberNote,
  splitMemory,
  turnTextFromMessages,
  workspacePath,
  writeBotMemory,
  writeWorkspace,
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

  it("writes workspace.md and remember/recall round-trip bot + workspace notes", () => {
    rememberNote(BOT, "Call me Sam.");
    rememberNote(BOT, "Team ships on Fridays.", "workspace");
    expect(existsSync(workspacePath())).toBe(true);
    expect(readWorkspace()).toContain("Team ships on Fridays.");
    expect(readBotMemory(BOT).user).toContain("Call me Sam.");

    const all = recallMemory(BOT);
    expect(all).toContain("Call me Sam.");
    expect(all).toContain("Team ships on Fridays.");
    expect(recallMemory(BOT, "friday")).toContain("Team ships on Fridays.");
    expect(recallMemory(BOT, "friday")).not.toContain("Call me Sam.");
    expect(recallMemory(BOT, "xyzzy")).toContain("No memory matching");

    writeWorkspace("Edited in settings.");
    expect(readWorkspace()).toContain("Edited in settings.");
  });

  it("picks any capable generateText, not only the bot's own driver", async () => {
    const calls: string[] = [];
    const claude = {
      instanceId: "claude",
      generateText: async (prompt: string) => {
        calls.push(`claude:${prompt.slice(0, 8)}`);
        return "Lives in Austin.";
      },
    };
    const codex = { instanceId: "codex" };
    const grok = {
      instanceId: "grok",
      generateText: async () => {
        throw new Error("xai down");
      },
    };

    expect(fleetGenerateText([codex], "codex")).toBeUndefined();

    const viaClaude = fleetGenerateText([codex, claude], "codex");
    expect(viaClaude).toBeTypeOf("function");
    await distillMemory({ botId: BOT, turnText: "User: I moved to Austin.", generateText: viaClaude });
    expect(readBotMemory(BOT).distilled).toContain("Lives in Austin.");
    expect(calls.some((c) => c.startsWith("claude:"))).toBe(true);

    const fallback = fleetGenerateText([grok, claude], "grok");
    await expect(fallback!("ping")).resolves.toBe("Lives in Austin.");
  });
});
