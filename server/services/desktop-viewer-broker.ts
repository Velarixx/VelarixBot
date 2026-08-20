import type { ComputerRegistry } from "../computer/registry.ts";
import type { ComputerViewerConnection } from "../computer/provider.ts";
import type { Repositories } from "../repositories/index.ts";
import type { DesktopAccessGrantService } from "./desktop-access-grants.ts";

export interface OpenedDesktopViewer {
  expiresAt: number;
  frames: AsyncIterable<ComputerViewerConnection["initialFrame"]>;
  authorized(): boolean;
}

export interface OwnerDesktopViewerBroker {
  /** Null is the uniform invalid-capability result. Provider failures reject. */
  open(accessToken: unknown, signal: AbortSignal): Promise<OpenedDesktopViewer | null>;
}

export interface DesktopViewerBroker {
  forOwner(ownerId: string): OwnerDesktopViewerBroker | null;
}

export class DesktopViewerProviderError extends Error {
  constructor() {
    super("desktop viewer provider unavailable");
    this.name = "DesktopViewerProviderError";
  }
}

export function createDesktopViewerBroker(options: {
  repos: Repositories;
  grants: DesktopAccessGrantService;
  computers: ComputerRegistry;
  openTimeoutMs: number;
  authorizationIntervalMs: number;
  now?: () => number;
}): DesktopViewerBroker {
  const { repos, grants, computers, openTimeoutMs, authorizationIntervalMs } = options;
  const now = options.now ?? Date.now;
  if (!Number.isSafeInteger(openTimeoutMs) || openTimeoutMs < 1 || openTimeoutMs > 30_000) {
    throw new TypeError("desktop viewer open timeout is invalid");
  }
  if (!Number.isSafeInteger(authorizationIntervalMs) || authorizationIntervalMs < 10 || authorizationIntervalMs > 5_000) {
    throw new TypeError("desktop viewer authorization interval is invalid");
  }

  return {
    forOwner(ownerId) {
      const ownerGrants = grants.forOwner(ownerId);
      if (!ownerGrants) return null;
      const durableGrants = repos.desktopAccessGrants.forOwner(ownerId);
      if (!durableGrants) return null;
      const bindings = repos.userWorkspaceBindings.forOwner(ownerId);

      return {
        async open(accessToken, signal) {
          // Both calls are synchronous and run in one event-loop turn: a
          // rebind cannot interleave between grant resolution and capture of
          // the exact current workspace identity.
          const resolved = ownerGrants.resolve(accessToken, "desktop:view");
          if (!resolved) return null;
          const binding = bindings.get();
          if (!binding) return null;

          const candidates = computers.list().filter(
            (provider) => provider.kind === binding.providerKind && typeof provider.openViewer === "function",
          );
          if (candidates.length !== 1) throw new DesktopViewerProviderError();
          const provider = candidates[0]!;

          const providerAbort = new AbortController();
          const forwardAbort = () => providerAbort.abort();
          signal.addEventListener("abort", forwardAbort, { once: true });
          let timeout: ReturnType<typeof setTimeout> | undefined;
          const timeoutFailure = new Promise<never>((_, reject) => {
            timeout = setTimeout(() => {
              providerAbort.abort();
              reject(new DesktopViewerProviderError());
            }, openTimeoutMs);
          });

          try {
            const connection = await Promise.race([
              provider.openViewer!(binding.machineId, { signal: providerAbort.signal }),
              timeoutFailure,
            ]);
            // Provider startup is asynchronous. Re-resolve after it settles so
            // expiry, revocation, rebind, and equal-identity ABA during the
            // handshake cannot release the first frame from a stale machine.
            const confirmed = ownerGrants.resolve(accessToken, "desktop:view");
            const currentBinding = bindings.get();
            if (
              signal.aborted ||
              !confirmed ||
              !currentBinding ||
              currentBinding.providerKind !== binding.providerKind ||
              currentBinding.machineId !== binding.machineId ||
              currentBinding.authorizationGeneration !== binding.authorizationGeneration
            ) {
              signal.removeEventListener("abort", forwardAbort);
              providerAbort.abort();
              return null;
            }
            const expectedWorkspace = { providerKind: binding.providerKind, machineId: binding.machineId };
            const isAuthorized = () => {
              try {
                return Boolean(durableGrants.resolve(accessToken, expectedWorkspace, "desktop:view", now()));
              } catch {
                return false;
              }
            };
            const iterator = connection.frames[Symbol.asyncIterator]();
            const nextOrAbort = async () => {
              let abort!: () => void;
              const aborted = new Promise<IteratorResult<ComputerViewerConnection["initialFrame"]>>((resolve) => {
                abort = () => resolve({ done: true, value: undefined });
                providerAbort.signal.addEventListener("abort", abort, { once: true });
              });
              try {
                return await Promise.race([iterator.next(), aborted]);
              } finally {
                providerAbort.signal.removeEventListener("abort", abort);
              }
            };
            return {
              expiresAt: confirmed.expiresAt,
              authorized: isAuthorized,
              frames: (async function* () {
                let monitor: ReturnType<typeof setInterval> | undefined;
                const monitorAuthorization = () => {
                  if (!isAuthorized()) providerAbort.abort();
                };
                try {
                  monitor = setInterval(monitorAuthorization, authorizationIntervalMs);
                  if (!isAuthorized() || providerAbort.signal.aborted) return;
                  yield connection.initialFrame;
                  while (!providerAbort.signal.aborted) {
                    const next = await nextOrAbort();
                    if (next.done || providerAbort.signal.aborted || !isAuthorized()) return;
                    yield next.value;
                  }
                } finally {
                  if (monitor) clearInterval(monitor);
                  signal.removeEventListener("abort", forwardAbort);
                  providerAbort.abort();
                  try {
                    void iterator.return?.().catch(() => undefined);
                  } catch {
                    // Provider cleanup cannot disclose or keep the view open.
                  }
                }
              })(),
            };
          } catch {
            signal.removeEventListener("abort", forwardAbort);
            providerAbort.abort();
            throw new DesktopViewerProviderError();
          } finally {
            if (timeout) clearTimeout(timeout);
          }
        },
      };
    },
  };
}
