import type { BotCreationTransport } from "./create-bot-transport";
import type { CatalogItem, CatalogTransport } from "./catalog-transport";

export type CreationModel =
  | { status: "idle" }
  | { status: "creating" }
  | { status: "refetching" }
  | { status: "success" }
  | { status: "quota" }
  | { status: "failure"; retry: "create" | "refresh" };

interface CatalogCreationCallbacks {
  setCreation(model: CreationModel): void;
  replaceCatalog(items: CatalogItem[]): void;
  clearProtectedState(): void;
  onSessionLost(): void;
}

export interface CatalogCreationCoordinator {
  start(): Promise<void>;
  retry(): Promise<void>;
  abort(): void;
  isPending(): boolean;
}

export function createCatalogCreationCoordinator(
  creationTransport: BotCreationTransport,
  catalogTransport: CatalogTransport,
  callbacks: CatalogCreationCallbacks,
): CatalogCreationCoordinator {
  let generation = 0;
  let controller: AbortController | null = null;
  let pending = false;
  let retry: "create" | "refresh" = "create";

  function isCurrent(currentGeneration: number, currentController: AbortController): boolean {
    return generation === currentGeneration && !currentController.signal.aborted;
  }

  function finish(): void {
    pending = false;
    controller = null;
  }

  function loseSession(currentGeneration: number, currentController: AbortController): void {
    if (!isCurrent(currentGeneration, currentController)) return;
    finish();
    callbacks.clearProtectedState();
    callbacks.onSessionLost();
  }

  async function refreshCatalog(
    currentGeneration: number,
    currentController: AbortController,
  ): Promise<void> {
    callbacks.setCreation({ status: "refetching" });
    let outcome;
    try {
      outcome = await catalogTransport.load(currentController.signal);
    } catch {
      outcome = { kind: "unavailable" } as const;
    }
    if (!isCurrent(currentGeneration, currentController)) return;
    if (outcome.kind === "unauthenticated") {
      loseSession(currentGeneration, currentController);
      return;
    }
    if (outcome.kind === "success") {
      callbacks.replaceCatalog(outcome.items);
      callbacks.setCreation({ status: "success" });
      finish();
      return;
    }
    retry = "refresh";
    callbacks.setCreation({ status: "failure", retry });
    finish();
  }

  async function start(): Promise<void> {
    if (pending) return;
    pending = true;
    retry = "create";
    const currentGeneration = ++generation;
    const currentController = new AbortController();
    controller = currentController;
    callbacks.setCreation({ status: "creating" });

    let outcome;
    try {
      outcome = await creationTransport.create(currentController.signal);
    } catch {
      outcome = { kind: "unavailable" } as const;
    }
    if (!isCurrent(currentGeneration, currentController)) return;
    if (outcome.kind === "unauthenticated") {
      loseSession(currentGeneration, currentController);
      return;
    }
    if (outcome.kind === "quota_reached") {
      callbacks.setCreation({ status: "quota" });
      finish();
      return;
    }
    if (outcome.kind === "unavailable") {
      callbacks.setCreation({ status: "failure", retry });
      finish();
      return;
    }
    await refreshCatalog(currentGeneration, currentController);
  }

  async function retryOperation(): Promise<void> {
    if (pending) return;
    if (retry === "create") {
      await start();
      return;
    }
    pending = true;
    const currentGeneration = ++generation;
    const currentController = new AbortController();
    controller = currentController;
    await refreshCatalog(currentGeneration, currentController);
  }

  function abort(): void {
    generation += 1;
    controller?.abort();
    controller = null;
    pending = false;
  }

  return {
    start,
    retry: retryOperation,
    abort,
    isPending: () => pending,
  };
}
