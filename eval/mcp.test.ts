import { describe, expect, it } from "vitest";

import { mcpMechanicalFail } from "./mcp.mjs";

describe("Codex MCP on-request mechanical invariants", () => {
  it("hard-fails the rc.10 Allow → rejected signature", () => {
    const fail = mcpMechanicalFail({
      reply: "I could not list bots: user rejected MCP tool call",
      messages: [{ kind: "activity", tool: { name: "list_bots", ok: false } }],
    });
    expect(fail.some((m) => /user rejected MCP tool call/i.test(m))).toBe(true);
    expect(fail.some((m) => /errored/i.test(m))).toBe(true);
  });

  it("hard-fails when there is no successful tool result", () => {
    const fail = mcpMechanicalFail({
      reply: "There are three bots in the sidebar.",
      messages: [{ kind: "text", text: "There are three bots in the sidebar." }],
    });
    expect(fail).toContain("no successful list_bots/create_bot tool result");
  });

  it("passes a single successful list_bots after Allow", () => {
    expect(
      mcpMechanicalFail({
        reply: "Roster from list_bots: Support, Ops, Research.",
        messages: [{ kind: "activity", tool: { name: "list_bots", ok: true } }],
      }),
    ).toEqual([]);
  });

  it("accepts create_bot as the forced MCP tool", () => {
    expect(
      mcpMechanicalFail({
        reply: "Created Ops.",
        messages: [{ kind: "activity", tool: { name: "create_bot", ok: true } }],
      }),
    ).toEqual([]);
  });
});
