import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProviderInstance, RuntimeEvent } from "../../contracts.ts";
import { HermesAgentDriver } from "./hermes.ts";

const HARNESS = join(dirname(fileURLToPath(import.meta.url)), "hermes-approval-lifecycle-harness.ts");
const APPROVAL_TIMEOUT_MS = 900_000;
const REPEATS = 5;
const realSetTimeout = globalThis.setTimeout.bind(globalThis);

interface HarnessRecord {
  type: string;
  run: string;
  pid: number;
  at: number;
  approvalId?: number | null;
  response?: { outcome?: { outcome?: string; optionId?: string } };
  node?: string;
  platform?: string;
}

const waitUntil = async <T>(read: () => T | undefined, label: string, timeoutMs = 10_000): Promise<T> => {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise<void>((resolve) => realSetTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
};

const eventAfter = (events: RuntimeEvent[], start: number, pred: (event: RuntimeEvent) => boolean) =>
  waitUntil(() => events.slice(start).find(pred), "runtime event");

const readRecords = (path: string): HarnessRecord[] => {
  try {
    return readFileSync(path, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as HarnessRecord);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
};

const processExists = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe.runIf(process.platform === "win32")("Hermes approval timeout, duplicate, retry, and cancellation lifecycle", () => {
  let scratch: string | undefined;
  let instance: ProviderInstance | undefined;

  afterEach(async () => {
    vi.useRealTimers();
    await instance?.dispose();
    instance = undefined;
    if (scratch) rmSync(scratch, { recursive: true, force: true });
    scratch = undefined;
  });

  it(
    "proves the exact fail-closed lifecycle with no orphaned approvals or real processes in five repeats",
    async () => {
      expect(Number(process.versions.node.split(".")[0]), "DHV-80 must execute under the repository's Node >=24 floor").toBeGreaterThanOrEqual(24);
      expect(process.platform).toBe("win32");

      scratch = mkdtempSync(join(tmpdir(), "dhv-80-hermes-approval-"));
      const logPath = join(scratch, "harness.ndjson");
      const events: RuntimeEvent[] = [];
      const allRequestIds = new Set<string>();
      const allPids = new Set<number>();

      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

      for (let repeat = 1; repeat <= REPEATS; repeat += 1) {
        const run = `repeat-${repeat}`;
        const threadId = `dhv-80-thread-${repeat}`;
        instance = await HermesAgentDriver.create({
          instanceId: `dhv-80-hermes-${repeat}`,
          displayName: "Hermes DHV-80",
          environment: {
            HERMES_APPROVAL_LIFECYCLE_LOG: logPath,
            HERMES_APPROVAL_LIFECYCLE_RUN: run,
          },
          enabled: true,
          config: { cli: HARNESS, fullAuto: false },
        });
        const unsubscribe = instance.adapter.onEvent((event) => events.push(event));

        const timeoutStart = events.length;
        await instance.adapter.sendTurn({ threadId, text: `${run}: timeout`, requireApproval: true });
        const timeoutOpened = await eventAfter(events, timeoutStart, (event) => event.type === "request.opened");
        const timeoutRequestId = timeoutOpened.requestId!;
        expect(timeoutRequestId).toBeTruthy();
        expect(allRequestIds.has(timeoutRequestId)).toBe(false);
        allRequestIds.add(timeoutRequestId);
        expect(vi.getTimerCount()).toBe(1);

        await vi.advanceTimersByTimeAsync(APPROVAL_TIMEOUT_MS - 1);
        expect(events.slice(timeoutStart).filter((event) => event.type === "request.resolved")).toHaveLength(0);
        expect(instance.adapter.hasSession(threadId)).toBe(true);

        await vi.advanceTimersByTimeAsync(1);
        const timeoutResolved = await eventAfter(
          events,
          timeoutStart,
          (event) => event.type === "request.resolved" && event.requestId === timeoutRequestId,
        );
        expect(timeoutResolved).toMatchObject({ behavior: "deny", source: "user" });
        const timeoutDone = await eventAfter(events, timeoutStart, (event) => event.type === "turn.completed");
        expect(timeoutDone).toMatchObject({ ok: true });
        expect(events.slice(timeoutStart).map((event) => event.type)).toEqual([
          "turn.started",
          "session.started",
          "request.opened",
          "runtime.error",
          "request.resolved",
          "turn.completed",
        ]);
        expect(events.slice(timeoutStart).filter((event) => event.type === "request.resolved")).toHaveLength(1);
        expect(events.slice(timeoutStart).find((event) => event.type === "runtime.error")).toMatchObject({
          message: "VelarixBot: nobody answered this permission request in time. Skip this action and finish what you can without it.",
        });
        await expect(
          instance.adapter.respondToRequest(threadId, timeoutRequestId, { behavior: "allow", source: "late-user" }),
        ).rejects.toThrow("no such pending request");

        const retryStart = events.length;
        await instance.adapter.sendTurn({ threadId, text: `${run}: explicit retry`, requireApproval: true });
        const retryOpened = await eventAfter(events, retryStart, (event) => event.type === "request.opened");
        const retryRequestId = retryOpened.requestId!;
        expect(retryRequestId).not.toBe(timeoutRequestId);
        expect(allRequestIds.has(retryRequestId)).toBe(false);
        allRequestIds.add(retryRequestId);
        await instance.adapter.respondToRequest(threadId, retryRequestId, { behavior: "allow", source: "user" });
        await eventAfter(
          events,
          retryStart,
          (event) => event.type === "request.resolved" && event.requestId === retryRequestId,
        );
        const retryDone = await eventAfter(events, retryStart, (event) => event.type === "turn.completed");
        expect(retryDone).toMatchObject({ ok: true });
        expect(events.slice(retryStart).map((event) => event.type)).toEqual([
          "turn.started",
          "session.started",
          "request.opened",
          "request.resolved",
          "turn.completed",
        ]);
        expect(events.slice(retryStart).filter((event) => event.type === "request.resolved")).toHaveLength(1);
        await expect(
          instance.adapter.respondToRequest(threadId, retryRequestId, { behavior: "deny", source: "duplicate-user" }),
        ).rejects.toThrow("no such pending request");

        const cancelStart = events.length;
        await instance.adapter.sendTurn({ threadId, text: `${run}: cancellation`, requireApproval: true });
        const cancelOpened = await eventAfter(events, cancelStart, (event) => event.type === "request.opened");
        const cancelRequestId = cancelOpened.requestId!;
        expect(allRequestIds.has(cancelRequestId)).toBe(false);
        allRequestIds.add(cancelRequestId);
        await instance.adapter.interruptTurn(threadId);
        const cancelResolved = await eventAfter(
          events,
          cancelStart,
          (event) => event.type === "request.resolved" && event.requestId === cancelRequestId,
        );
        expect(cancelResolved).toMatchObject({ behavior: "deny", source: "system" });
        const cancelDone = await eventAfter(events, cancelStart, (event) => event.type === "turn.completed");
        expect(cancelDone).toMatchObject({ ok: true, stopReason: "cancelled" });
        expect(events.slice(cancelStart).map((event) => event.type)).toEqual([
          "turn.started",
          "session.started",
          "request.opened",
          "request.resolved",
          "turn.completed",
        ]);
        expect(events.slice(cancelStart).filter((event) => event.type === "request.resolved")).toHaveLength(1);
        await expect(
          instance.adapter.respondToRequest(threadId, cancelRequestId, { behavior: "allow", source: "late-user" }),
        ).rejects.toThrow("no such pending request");
        expect(instance.adapter.hasSession(threadId)).toBe(false);
        expect(vi.getTimerCount()).toBe(0);

        const expectedProcesses = repeat * 3;
        const records = await waitUntil(
          () => {
            const value = readRecords(logPath);
            return value.filter((record) => record.type === "process.started").length === expectedProcesses ? value : undefined;
          },
          `${expectedProcesses} harness starts`,
        );
        const runRecords = records.filter((record) => record.run === run);
        const starts = runRecords.filter((record) => record.type === "process.started");
        expect(starts).toHaveLength(3);
        expect(starts.every((record) => record.platform === "win32" && Number(record.node?.split(".")[0]) >= 24)).toBe(true);
        expect(runRecords.filter((record) => record.type === "approval.opened")).toHaveLength(3);
        expect(runRecords.filter((record) => record.type === "approval.response")).toHaveLength(3);
        expect(runRecords.filter((record) => record.type === "session.cancelled")).toHaveLength(1);
        expect(
          runRecords
            .filter((record) => record.type === "approval.response")
            .map((record) => record.response?.outcome),
        ).toEqual([
          { outcome: "selected", optionId: "reject-once" },
          { outcome: "selected", optionId: "allow-once" },
          { outcome: "cancelled" },
        ]);

        for (const start of starts) {
          expect(allPids.has(start.pid)).toBe(false);
          allPids.add(start.pid);
          await waitUntil(() => (processExists(start.pid) ? undefined : true), `harness pid ${start.pid} to exit`);
        }

        unsubscribe();
        await instance.dispose();
        instance = undefined;
      }

      expect(allRequestIds.size).toBe(REPEATS * 3);
      expect(allPids.size).toBe(REPEATS * 3);
      expect(events.filter((event) => event.type === "request.opened")).toHaveLength(REPEATS * 3);
      expect(events.filter((event) => event.type === "request.resolved")).toHaveLength(REPEATS * 3);
      expect(events.filter((event) => event.type === "turn.completed")).toHaveLength(REPEATS * 3);
      expect([...allPids].filter(processExists)).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    },
    120_000,
  );
});
