import { describe, expect, it, vi } from "vitest";
import { createCatalogCreationCoordinator, type CreationModel } from "./catalog-creation";
import type { BotCreationTransport, CreateBotOutcome } from "./create-bot-transport";
import type { CatalogItem, CatalogLoadOutcome, CatalogTransport } from "./catalog-transport";

const item: CatalogItem = {
  name: "Planner",
  title: "Planning assistant",
  description: "Builds a plan.",
  color: "green",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function harness(create: BotCreationTransport["create"], load: CatalogTransport["load"]) {
  const phases: CreationModel[] = [];
  const replacements: CatalogItem[][] = [];
  const lifecycle: string[] = [];
  const coordinator = createCatalogCreationCoordinator(
    { create },
    { load },
    {
      setCreation: (model) => phases.push(model),
      replaceCatalog: (items) => replacements.push(items),
      clearProtectedState: () => lifecycle.push("cleared"),
      onSessionLost: () => lifecycle.push("session-lost"),
    },
  );
  return { coordinator, phases, replacements, lifecycle };
}

describe("catalog creation coordinator", () => {
  it("accepts 201 only after a fresh bounded catalog load replaces the projection", async () => {
    const create = vi.fn(async (): Promise<CreateBotOutcome> => ({ kind: "success" }));
    const load = vi.fn(async (): Promise<CatalogLoadOutcome> => ({ kind: "success", items: [item] }));
    const { coordinator, phases, replacements } = harness(create, load);

    await coordinator.start();

    expect(phases).toEqual([{ status: "creating" }, { status: "refetching" }, { status: "success" }]);
    expect(load).toHaveBeenCalledOnce();
    expect(replacements).toEqual([[item]]);
    expect(coordinator.isPending()).toBe(false);
  });

  it("clears protected state before invoking the existing session-loss path", async () => {
    const { coordinator, phases, replacements, lifecycle } = harness(
      vi.fn(async (): Promise<CreateBotOutcome> => ({ kind: "unauthenticated" })),
      vi.fn(),
    );

    await coordinator.start();

    expect(lifecycle).toEqual(["cleared", "session-lost"]);
    expect(phases).toEqual([{ status: "creating" }]);
    expect(replacements).toEqual([]);
  });

  it("uses the same protected-state clearing path when the post-create refetch returns 401", async () => {
    const { coordinator, phases, replacements, lifecycle } = harness(
      vi.fn(async (): Promise<CreateBotOutcome> => ({ kind: "success" })),
      vi.fn(async (): Promise<CatalogLoadOutcome> => ({ kind: "unauthenticated" })),
    );

    await coordinator.start();

    expect(phases).toEqual([{ status: "creating" }, { status: "refetching" }]);
    expect(replacements).toEqual([]);
    expect(lifecycle).toEqual(["cleared", "session-lost"]);
  });

  it("uses generic quota and retryable failure states", async () => {
    const quota = harness(vi.fn(async (): Promise<CreateBotOutcome> => ({ kind: "quota_reached" })), vi.fn());
    await quota.coordinator.start();
    expect(quota.phases.at(-1)).toEqual({ status: "quota" });

    const unavailable = harness(vi.fn(async (): Promise<CreateBotOutcome> => ({ kind: "unavailable" })), vi.fn());
    await unavailable.coordinator.start();
    expect(unavailable.phases.at(-1)).toEqual({ status: "failure", retry: "create" });
  });

  it("prevents double submission through creation and refetch", async () => {
    const createResult = deferred<CreateBotOutcome>();
    const loadResult = deferred<CatalogLoadOutcome>();
    const create = vi.fn(() => createResult.promise);
    const load = vi.fn(() => loadResult.promise);
    const { coordinator } = harness(create, load);

    const first = coordinator.start();
    const duplicateDuringCreate = coordinator.start();
    expect(create).toHaveBeenCalledOnce();
    createResult.resolve({ kind: "success" });
    await Promise.resolve();
    const duplicateDuringRefresh = coordinator.start();
    expect(create).toHaveBeenCalledOnce();
    expect(load).toHaveBeenCalledOnce();
    loadResult.resolve({ kind: "success", items: [item] });
    await Promise.all([first, duplicateDuringCreate, duplicateDuringRefresh]);
  });

  it("retries only the GET when refetch fails after a known 201", async () => {
    const create = vi.fn(async () => ({ kind: "success" as const }));
    const load = vi.fn()
      .mockResolvedValueOnce({ kind: "unavailable" })
      .mockResolvedValueOnce({ kind: "success", items: [item] });
    const { coordinator, phases, replacements } = harness(create, load);

    await coordinator.start();
    expect(phases.at(-1)).toEqual({ status: "failure", retry: "refresh" });
    await coordinator.retry();

    expect(create).toHaveBeenCalledOnce();
    expect(load).toHaveBeenCalledTimes(2);
    expect(replacements).toEqual([[item]]);
    expect(phases.at(-1)).toEqual({ status: "success" });
  });

  it("aborts on unmount and suppresses stale completion even when a transport ignores abort", async () => {
    const firstResult = deferred<CreateBotOutcome>();
    const secondResult = deferred<CreateBotOutcome>();
    const signals: AbortSignal[] = [];
    const create = vi.fn((signal: AbortSignal) => {
      signals.push(signal);
      return signals.length === 1 ? firstResult.promise : secondResult.promise;
    });
    const load = vi.fn();
    const { coordinator, phases, replacements } = harness(create, load);

    const stale = coordinator.start();
    coordinator.abort();
    expect(signals[0]?.aborted).toBe(true);
    const current = coordinator.start();
    secondResult.resolve({ kind: "quota_reached" });
    await current;
    firstResult.resolve({ kind: "success" });
    await stale;

    expect(load).not.toHaveBeenCalled();
    expect(replacements).toEqual([]);
    expect(phases).toEqual([{ status: "creating" }, { status: "creating" }, { status: "quota" }]);
  });
});
