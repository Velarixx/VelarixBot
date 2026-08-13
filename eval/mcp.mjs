// Mechanical invariants for the Codex on-request MCP eval scenario.
// Hard-fail on the rc.10 signature: Allow clicked but Codex still reports
// "user rejected MCP tool call", a tool error, or no successful tool result.
// This is not a judge score.

const REJECTED = /user rejected MCP tool call/i;
const MCP_TOOL = /list_bots|create_bot/i;

function toolName(message) {
  return String(message?.tool?.name ?? "");
}

function mcpToolMessages(messages) {
  return (messages ?? []).filter((m) => m?.kind === "activity" && MCP_TOOL.test(toolName(m)));
}

/** Failures for one Codex MCP turn. Empty array = pass. */
export function mcpMechanicalFail(turn) {
  if (!turn) return ["Codex MCP scenario produced no transcript"];
  const missing = [];
  const reply = String(turn.reply ?? "");
  if (REJECTED.test(reply)) {
    missing.push('reply contains "user rejected MCP tool call" (Allow did not approve the MCP tool)');
  }
  const tools = mcpToolMessages(turn.messages);
  const errored = tools.filter((m) => m.tool?.ok === false);
  const ok = tools.filter((m) => m.tool?.ok === true);
  if (errored.length) {
    missing.push(`MCP tool errored (${errored.map((m) => toolName(m)).join(", ")})`);
  }
  if (!ok.length) missing.push("no successful list_bots/create_bot tool result");
  return missing;
}
