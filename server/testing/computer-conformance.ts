// ComputerProvider conformance suite — the behavioral contract every
// provider (first-party or configured) must pass. Capability-driven: an
// operation a provider declares must work; an operation it does not declare
// must reject with the canonical unsupported error — never hang, never
// pretend. Powered in-repo by the FakeComputerProvider and run against
// local, box (fake vendor HTTP), and fake (computer/conformance.test.ts).
// Lives in server/testing because it imports vitest (dev-only, unshipped).
import { describe, expect, it } from "vitest";

import type { ComputerProvider, ExecuteEvent } from "../computer/provider.ts";

export interface ComputerConformanceContext {
  provider: ComputerProvider;
  botId: string;
  /** Secret values (tokens) that must never appear in argv or JSON results. */
  secrets?: string[];
  cleanup?(): Promise<void> | void;
}

const UNSUPPORTED = /does not support/;

async function collect(stream: AsyncIterable<ExecuteEvent>): Promise<ExecuteEvent[]> {
  const events: ExecuteEvent[] = [];
  for await (const ev of stream) events.push(ev);
  return events;
}

export function describeComputerProviderConformance(
  label: string,
  setup: () => Promise<ComputerConformanceContext>,
): void {
  // fresh provider per test — no cross-test machine state
  const withProvider = async (fn: (ctx: ComputerConformanceContext) => Promise<void>): Promise<void> => {
    const ctx = await setup();
    try {
      await fn(ctx);
    } finally {
      await ctx.cleanup?.();
    }
  };

  describe(`ComputerProvider conformance: ${label}`, () => {
    it("declares a stable identity and a full capability record", () =>
      withProvider(async ({ provider }) => {
        expect(provider.id).toBeTruthy();
        expect(provider.kind).toBeTruthy();
        expect(provider.displayName).toBeTruthy();
        for (const key of ["exec", "screenshot", "files", "desktopUrl", "suspend", "destroy", "mcp"] as const) {
          expect(typeof provider.capabilities[key], `capabilities.${key}`).toBe("boolean");
        }
        expect(typeof provider.turnPrompt).toBe("string");
      }));

    it("status() resolves before any provisioning and reports a machine or null", () =>
      withProvider(async ({ provider, botId }) => {
        const status = await provider.status(botId);
        expect(typeof status.configured).toBe("boolean");
        expect(status.machine === null || typeof status.machine.id === "string").toBe(true);
      }));

    it("provision() yields a machine that lands in status(), and reprovisioning reuses it", () =>
      withProvider(async ({ provider, botId }) => {
        const first = await provider.provision({ id: botId, name: "Conformance Bot" });
        expect(first.machineId).toBeTruthy();
        const status = await provider.status(botId);
        expect(status.configured).toBe(true);
        expect(status.machine?.id).toBe(first.machineId);
        const second = await provider.provision({ id: botId, name: "Conformance Bot" });
        expect(second.machineId).toBe(first.machineId);
        expect(second.reused).toBe(true);
      }));

    it("execute() streams events ending in exit — or rejects when undeclared", () =>
      withProvider(async ({ provider, botId }) => {
        await provider.provision({ id: botId, name: "Conformance Bot" });
        if (!provider.capabilities.exec) {
          await expect(collect(provider.execute(botId, "echo conformance"))).rejects.toThrow(UNSUPPORTED);
          return;
        }
        const events = await collect(provider.execute(botId, "echo conformance"));
        expect(events.length).toBeGreaterThan(0);
        const exit = events.at(-1)!;
        expect(exit.type).toBe("exit");
        if (exit.type === "exit") expect(exit.exitCode === null || typeof exit.exitCode === "number").toBe(true);
        expect(events.some((e) => e.type === "stdout" && e.data.length > 0)).toBe(true);
      }));

    it("connectScreen() mints a fresh URL exactly when desktopUrl is declared", () =>
      withProvider(async ({ provider, botId }) => {
        await provider.provision({ id: botId, name: "Conformance Bot" });
        if (provider.capabilities.desktopUrl) {
          const conn = await provider.connectScreen(botId);
          expect(conn.kind).toBe("url");
          if (conn.kind === "url") expect(conn.url).toBeTruthy();
          return;
        }
        const result = await provider.connectScreen(botId).catch((e: Error) => e);
        expect(result instanceof Error ? UNSUPPORTED.test(result.message) : result.kind === "local").toBe(true);
      }));

    it("screenshot() returns a base64 frame — or rejects when undeclared", () =>
      withProvider(async ({ provider, botId }) => {
        await provider.provision({ id: botId, name: "Conformance Bot" });
        if (!provider.capabilities.screenshot) {
          await expect(provider.screenshot(botId)).rejects.toThrow(UNSUPPORTED);
          return;
        }
        const shot = await provider.screenshot(botId);
        expect(shot.png.length).toBeGreaterThan(0);
        expect(Buffer.from(shot.png, "base64").length).toBeGreaterThan(0);
        expect(["png", "jpeg"]).toContain(shot.format);
      }));

    it("readFile() enforces absolute paths — or rejects when undeclared", () =>
      withProvider(async ({ provider, botId }) => {
        await provider.provision({ id: botId, name: "Conformance Bot" });
        if (!provider.capabilities.files) {
          await expect(provider.readFile(botId, "/tmp/conformance.txt")).rejects.toThrow(UNSUPPORTED);
          return;
        }
        await expect(provider.readFile(botId, "relative.txt")).rejects.toThrow(/absolute/);
        await expect(provider.readFile(botId, "/tmp/../etc/passwd")).rejects.toThrow(/absolute/);
        const read = await provider.readFile(botId, "/tmp/conformance.txt");
        expect(read.path).toBe("/tmp/conformance.txt");
        expect(Buffer.from(read.content, "base64").length).toBeGreaterThan(0);
      }));

    it("suspend() parks the machine without destroying it — or rejects when undeclared", () =>
      withProvider(async ({ provider, botId }) => {
        await provider.provision({ id: botId, name: "Conformance Bot" });
        if (!provider.capabilities.suspend) {
          await expect(provider.suspend(botId)).rejects.toThrow(UNSUPPORTED);
          return;
        }
        await provider.suspend(botId);
        const status = await provider.status(botId);
        expect(status.machine).not.toBeNull();
      }));

    it("destroy() removes the machine from status() — or rejects when undeclared", () =>
      withProvider(async ({ provider, botId }) => {
        await provider.provision({ id: botId, name: "Conformance Bot" });
        if (!provider.capabilities.destroy) {
          await expect(provider.destroy(botId)).rejects.toThrow(UNSUPPORTED);
          return;
        }
        await provider.destroy(botId);
        const status = await provider.status(botId);
        expect(status.machine).toBeNull();
      }));

    it("mcpIntegration() is a spawn contract with secrets in env, never argv", () =>
      withProvider(async ({ provider, botId, secrets = [] }) => {
        const provisioned = await provider.provision({ id: botId, name: "Conformance Bot" });
        const mcp = await provider.mcpIntegration(botId, { machineId: provisioned.machineId });
        if (!provider.capabilities.mcp) {
          expect(mcp).toBeNull();
          return;
        }
        expect(mcp).not.toBeNull();
        expect(typeof mcp!.command).toBe("string");
        expect(mcp!.command.length).toBeGreaterThan(0);
        expect(Array.isArray(mcp!.args)).toBe(true);
        for (const arg of mcp!.args) expect(typeof arg).toBe("string");
        expect(mcp!.env && typeof mcp!.env).toBe("object");
        const argvText = JSON.stringify([mcp!.command, ...mcp!.args]);
        for (const secret of secrets) expect(argvText).not.toContain(secret);
      }));

    it("status() and provision() results never leak secrets", () =>
      withProvider(async ({ provider, botId, secrets = [] }) => {
        const provisioned = await provider.provision({ id: botId, name: "Conformance Bot" });
        const status = await provider.status(botId);
        const text = JSON.stringify({ provisioned, status });
        for (const secret of secrets) expect(text).not.toContain(secret);
      }));
  });
}
