// Shared-box mode (3.2.4 + D4) through the box ComputerProvider — fake
// vendor HTTP only, no live ascii.dev, no real HOME. The SPI itself is
// untouched: sharing is provider-internal, and these tests prove the
// provider-visible consequences (one machine for every bot, per-bot cwd on
// exec, prefix-scoped cleanup, per-bot mode bit-identical to before).
import { describe, expect, it } from "vitest";

import type { AppConfig } from "../config.ts";
import { destroyStaleBotBoxes, listStaleBotBoxes } from "../box.ts";
import { startFakeBoxVendor, type FakeBoxVendor } from "../testing/fake-box.ts";
import { BoxComputerProviderFactory } from "./box.ts";
import { createComputerRegistry } from "./registry.ts";
import type { ComputerProvider, ExecuteEvent } from "./provider.ts";

const TOKEN = "tok_shared_box_never_in_argv";

async function boxProvider(
  boxKnobs: Omit<NonNullable<AppConfig["box"]>, "token" | "url"> = {},
): Promise<{ provider: ComputerProvider; vendor: FakeBoxVendor; appConfig: AppConfig; close(): Promise<void> }> {
  const vendor = await startFakeBoxVendor({ token: TOKEN });
  const appConfig: AppConfig = { box: { token: TOKEN, url: vendor.base, ...boxKnobs } };
  const provider = await BoxComputerProviderFactory.create({ id: "box", config: {}, appConfig });
  return { provider, vendor, appConfig, close: () => vendor.close() };
}

async function collect(stream: AsyncIterable<ExecuteEvent>): Promise<ExecuteEvent[]> {
  const events: ExecuteEvent[] = [];
  for await (const ev of stream) events.push(ev);
  return events;
}

describe("shared mode provisions ONE box for every bot", () => {
  it("two bots resolve to the same machine id and the second provision is a reuse", async () => {
    const { provider, vendor, close } = await boxProvider({ shared: true, namePrefix: "dyon-" });
    try {
      const first = await provider.provision({ id: "bot-a", name: "Ada" });
      const second = await provider.provision({ id: "bot-b", name: "Bea" });
      expect(first.machineName).toBe("dyon-velarixbot-workspace");
      expect(second.machineId).toBe(first.machineId);
      expect(second.reused).toBe(true);
      expect((await provider.status("bot-b")).machine?.id).toBe(first.machineId);
      // exactly one box exists on the vendor, under the exact shared name
      expect([...vendor.boxes.values()].map((b) => b.name)).toEqual(["dyon-velarixbot-workspace"]);
    } finally {
      await close();
    }
  });

  it("shared=false (and absent knobs) keeps today's per-bot boxes", async () => {
    const { provider, vendor, close } = await boxProvider();
    try {
      const a = await provider.provision({ id: "bot-a", name: "Ada" });
      const b = await provider.provision({ id: "bot-b", name: "Bea" });
      expect(a.machineName).toBe("velarixbot-workspace-bot-a");
      expect(b.machineName).toBe("velarixbot-workspace-bot-b");
      expect(b.machineId).not.toBe(a.machineId);
      expect(b.reused).toBe(false);
      expect(vendor.boxes.size).toBe(2);
    } finally {
      await close();
    }
  });

  it("namePrefix applies in per-bot mode too", async () => {
    const { provider, close } = await boxProvider({ namePrefix: "dyon-" });
    try {
      const a = await provider.provision({ id: "bot-a", name: "Ada" });
      expect(a.machineName).toBe("dyon-velarixbot-workspace-bot-a");
    } finally {
      await close();
    }
  });
});

describe("shared mode runs each bot in its own ~/workspaces/<botId>", () => {
  it("execute() wraps the command (multi-line intact); per-bot mode does not", async () => {
    const shared = await boxProvider({ shared: true });
    try {
      await shared.provider.provision({ id: "bot-a", name: "Ada" });
      const boxRecord = [...shared.vendor.boxes.values()][0];
      const before = boxRecord.commands.length;
      await collect(shared.provider.execute("bot-a", "echo one\necho two"));
      expect(boxRecord.commands[before]).toBe(
        "mkdir -p ~/workspaces/bot-a && cd ~/workspaces/bot-a && {\necho one\necho two\n}",
      );
    } finally {
      await shared.close();
    }

    const perBot = await boxProvider();
    try {
      await perBot.provider.provision({ id: "bot-a", name: "Ada" });
      const boxRecord = [...perBot.vendor.boxes.values()][0];
      const before = boxRecord.commands.length;
      await collect(perBot.provider.execute("bot-a", "echo one"));
      expect(boxRecord.commands[before]).toBe("echo one");
    } finally {
      await perBot.close();
    }
  });

  it("the MCP spawn contract carries OGB_BOX_CWD only in shared mode — never on argv", async () => {
    const shared = await boxProvider({ shared: true });
    try {
      const provisioned = await shared.provider.provision({ id: "bot-a", name: "Ada" });
      const mcp = await shared.provider.mcpIntegration("bot-a", { machineId: provisioned.machineId });
      expect(mcp!.env.OGB_BOX_CWD).toBe("~/workspaces/bot-a");
      expect(JSON.stringify(mcp!.args)).not.toContain(TOKEN);
      expect(JSON.stringify(mcp!.args)).not.toContain("workspaces");
    } finally {
      await shared.close();
    }

    const perBot = await boxProvider();
    try {
      const provisioned = await perBot.provider.provision({ id: "bot-a", name: "Ada" });
      const mcp = await perBot.provider.mcpIntegration("bot-a", { machineId: provisioned.machineId });
      expect(mcp!.env.OGB_BOX_CWD).toBeUndefined();
    } finally {
      await perBot.close();
    }
  });
});

describe("cleanup of stranded per-bot boxes (migration, 3.8)", () => {
  it("destroys only ids from this install's prefix-scoped stale list", async () => {
    const { vendor, appConfig, close } = await boxProvider({ shared: true, namePrefix: "dyon-" });
    try {
      // seed the vendor with the shared box, two stale per-bot boxes, and a foreign one
      const seed = (id: string, name: string) => vendor.boxes.set(id, { id, name, state: "idle", commands: [] });
      seed("s1", "dyon-velarixbot-workspace");
      seed("a1", "dyon-velarixbot-workspace-bot-a");
      seed("b1", "dyon-velarixbot-workspace-bot-b");
      seed("f1", "mila-velarixbot-workspace-bot-a");

      expect((await listStaleBotBoxes(appConfig)).map((b) => b.id).sort()).toEqual(["a1", "b1"]);

      // asks for a stale box, the shared box, and a foreign box — only the
      // stale one dies; the others come back as explicit per-id failures
      const result = await destroyStaleBotBoxes(appConfig, ["a1", "s1", "f1"]);
      expect(result.destroyed).toEqual([{ id: "a1", name: "dyon-velarixbot-workspace-bot-a" }]);
      expect(result.failed.map((f) => f.id).sort()).toEqual(["f1", "s1"]);
      expect(vendor.boxes.has("a1")).toBe(false);
      expect(vendor.boxes.has("s1")).toBe(true);
      expect(vendor.boxes.has("f1")).toBe(true);
    } finally {
      await close();
    }
  });
});

describe("shared trust domain lands in the audit log", () => {
  it("exec / read / join on the shared machine carry machine:'shared'; per-bot mode stays silent", async () => {
    const { readAudit } = await import("../approvals.ts");
    const shared = await boxProvider({ shared: true });
    try {
      await shared.provider.provision({ id: "audit-bot-1", name: "Ada" });
      await collect(shared.provider.execute("audit-bot-1", "ls"));
      await shared.provider.readFile("audit-bot-1", "/tmp/x.txt");
      await shared.provider.connectScreen("audit-bot-1");
      const mine = readAudit().filter((e) => e.bot === "audit-bot-1");
      expect(mine.map((e) => ({ tool: e.tool, decision: e.decision, machine: e.machine }))).toEqual([
        { tool: "computer_exec", decision: "computer.exec", machine: "shared" },
        { tool: "computer_read_file", decision: "computer.read", machine: "shared" },
        { tool: "computer_join", decision: "computer.join", machine: "shared" },
      ]);
    } finally {
      await shared.close();
    }

    const perBot = await boxProvider();
    try {
      await perBot.provider.provision({ id: "audit-bot-2", name: "Bea" });
      await collect(perBot.provider.execute("audit-bot-2", "ls"));
      expect(readAudit().filter((e) => e.bot === "audit-bot-2")).toEqual([]);
    } finally {
      await perBot.close();
    }
  });
});

describe("strict decode never crashes boot (registry shadow rule)", () => {
  it("an invalid box.shared downgrades the provider to an unavailable shadow", async () => {
    const cfg: AppConfig = { box: { token: "t", shared: "yes" as unknown as boolean } };
    const registry = await createComputerRegistry({ cfg });
    const provider = registry.get("box")!;
    const status = await provider.status("bot-a");
    expect(status.configured).toBe(false);
    expect(status.reason).toMatch(/box\.shared/);
    await expect(provider.provision({ id: "bot-a", name: "Ada" })).rejects.toThrow(/box\.shared/);
  });
});
