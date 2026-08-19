// Dedicated real-process ACP peer for hermes-approval-lifecycle.integration.test.ts.
// It intentionally has no imports from shared test fixtures: DHV-80 owns this
// entire protocol surface and can prove process teardown from an append-only log.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const logPath = process.env.HERMES_APPROVAL_LIFECYCLE_LOG;
if (!logPath) throw new Error("HERMES_APPROVAL_LIFECYCLE_LOG is required");

const run = process.env.HERMES_APPROVAL_LIFECYCLE_RUN ?? "unknown";
const argv = process.argv.slice(2);
if (argv.length !== 1 || argv[0] !== "acp") {
  process.stderr.write(`expected exact Hermes argv [\"acp\"], received ${JSON.stringify(argv)}\n`);
  process.exit(2);
}

const record = (type: string, detail: Record<string, unknown> = {}) => {
  appendFileSync(logPath, `${JSON.stringify({ type, run, pid: process.pid, at: Date.now(), ...detail })}\n`, "utf8");
};
const send = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`);
const result = (id: unknown, value: unknown) => send({ jsonrpc: "2.0", id, result: value });

let promptId: unknown = null;
let approvalId: number | null = null;

record("process.started", { argv, node: process.versions.node, platform: process.platform });

createInterface({ input: process.stdin }).on("line", (line) => {
  let message: any;
  try {
    message = JSON.parse(line);
  } catch {
    record("protocol.invalid_json");
    return;
  }

  if (
    approvalId !== null &&
    message.id === approvalId &&
    (Object.prototype.hasOwnProperty.call(message, "result") || Object.prototype.hasOwnProperty.call(message, "error"))
  ) {
    record("approval.response", { approvalId, response: message.result ?? message.error });
    approvalId = null;
    if (promptId !== null) {
      const id = promptId;
      promptId = null;
      result(id, { stopReason: "end_turn" });
    }
    return;
  }

  switch (message.method) {
    case "initialize":
      result(message.id, {
        protocolVersion: 1,
        authMethods: [{ id: "openai-codex", type: "agent" }, { id: "hermes-setup", type: "terminal" }],
      });
      break;
    case "authenticate":
      result(message.id, {});
      break;
    case "session/new":
      result(message.id, { sessionId: `dhv-80-${process.pid}` });
      break;
    case "session/prompt": {
      promptId = message.id;
      approvalId = process.pid;
      const text = message.params?.prompt?.find((block: { type?: string }) => block?.type === "text")?.text;
      record("approval.opened", { approvalId, text });
      send({
        jsonrpc: "2.0",
        id: approvalId,
        method: "session/request_permission",
        params: {
          sessionId: message.params?.sessionId,
          toolCall: { kind: "execute", title: "DHV-80 lifecycle probe", rawInput: { command: "echo dhv-80" } },
          options: [
            { optionId: "allow-once", kind: "allow_once" },
            { optionId: "reject-once", kind: "reject_once" },
          ],
        },
      });
      break;
    }
    case "session/cancel":
      record("session.cancelled", { approvalId });
      if (promptId !== null) {
        const id = promptId;
        promptId = null;
        result(id, { stopReason: "cancelled" });
      }
      break;
    default:
      if (message.id !== undefined) {
        send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "method not found" } });
      }
  }
});
