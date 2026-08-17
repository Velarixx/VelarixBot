import { describe, expect, it } from "vitest";

import { agentsCommsPrompt } from "./chief-of-staff.ts";

describe("coordinator agents prompt", () => {
  it("tells the coordinator to use delegate_bot and not wait", () => {
    const prompt = agentsCommsPrompt();
    expect(prompt).toContain("delegate_bot");
    expect(prompt).toMatch(/do not wait/i);
    expect(prompt).toContain("ask_bot");
    expect(prompt).toContain("list_bots");
    expect(prompt).toContain("create_bot");
    expect(prompt).toContain("delete_bot");
    expect(prompt).toContain("update_bot");
    expect(prompt).not.toMatch(/wait for the teammate's actual reply/i);
  });
});
