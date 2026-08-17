// The computer-proxy MCP hits the Box REST commands endpoint directly
// (never execOnBox), so shared mode's per-bot cwd must be re-applied by the
// proxy itself from the spawn contract (OGB_BOX_CWD). Real proxy process,
// fake vendor HTTP — no live ascii.dev, Windows-safe (plain node spawn, no
// shebang, no shell).
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { startFakeBoxVendor } from "./testing/fake-box.ts";

const PROXY = join(dirname(fileURLToPath(import.meta.url)), "computer-proxy.ts");
const TOKEN = "tok_proxy_cwd_never_in_argv";

/** Drive one computer_exec tools/call through a real proxy process. */
async function execViaProxy(env: Record<string, string>, command: string): Promise<string> {
  const child = spawn(process.execPath, [PROXY], {
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      ...env,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (c) => (stderr += c));
  const reply = new Promise<string>((resolve, reject) => {
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
      for (const line of out.split("\n")) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === 2) return resolve(String(msg.result?.content?.[0]?.text ?? ""));
        } catch {
          /* partial line */
        }
      }
    });
    child.on("close", (code) => reject(new Error(`proxy exited ${code} before replying. stderr:\n${stderr}`)));
  });
  child.stdin.write(
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } }) + "\n",
  );
  child.stdin.write(
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "computer_exec", arguments: { command } } }) + "\n",
  );
  try {
    return await reply;
  } finally {
    child.kill();
  }
}

describe("computer-proxy shared-mode cwd wrap", () => {
  it("wraps computer_exec in the bot's workspace dir when OGB_BOX_CWD is set", async () => {
    const vendor = await startFakeBoxVendor({ token: TOKEN });
    try {
      const create = await fetch(`${vendor.base}/boxes`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      const boxId = ((await create.json()) as { box: { id: string } }).box.id;
      const text = await execViaProxy(
        { OGB_BOX_URL: vendor.base, OGB_BOX_ID: boxId, OGB_BOX_TOKEN: TOKEN, OGB_BOX_CWD: "~/workspaces/bot-a" },
        "echo one\necho two",
      );
      expect(text).toContain("exit 0");
      expect(vendor.boxes.get(boxId)!.commands).toEqual([
        "mkdir -p ~/workspaces/bot-a && cd ~/workspaces/bot-a && {\necho one\necho two\n}",
      ]);
    } finally {
      await vendor.close();
    }
  }, 20_000);

  it("leaves commands untouched without OGB_BOX_CWD, and rejects a malformed one", async () => {
    const vendor = await startFakeBoxVendor({ token: TOKEN });
    try {
      const create = await fetch(`${vendor.base}/boxes`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      const boxId = ((await create.json()) as { box: { id: string } }).box.id;
      await execViaProxy({ OGB_BOX_URL: vendor.base, OGB_BOX_ID: boxId, OGB_BOX_TOKEN: TOKEN }, "echo plain");
      // a cwd outside the sanitized ~/workspaces/<id> grammar is ignored —
      // the proxy never splices unvetted text into a shell line
      await execViaProxy(
        { OGB_BOX_URL: vendor.base, OGB_BOX_ID: boxId, OGB_BOX_TOKEN: TOKEN, OGB_BOX_CWD: "~/workspaces/x; rm -rf /" },
        "echo guarded",
      );
      expect(vendor.boxes.get(boxId)!.commands).toEqual(["echo plain", "echo guarded"]);
    } finally {
      await vendor.close();
    }
  }, 20_000);
});
