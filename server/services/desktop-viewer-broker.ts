import type { ComputerRegistry } from "../computer/registry.ts";
import type { ComputerViewerConnection } from "../computer/provider.ts";
import type { Repositories } from "../repositories/index.ts";
import type { DesktopAccessGrantService } from "./desktop-access-grants.ts";

export interface OpenedDesktopViewer {
  expiresAt: number;
  connection: ComputerViewerConnection;
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
}): DesktopViewerBroker {
  const { repos, grants, computers, openTimeoutMs } = options;
  if (!Number.isSafeInteger(openTimeoutMs) || openTimeoutMs < 1 || openTimeoutMs > 30_000) {
    throw new TypeError("desktop viewer open timeout is invalid");
  }

  return {
    forOwner(ownerId) {
      const ownerGrants = grants.forOwner(ownerId);
      if (!ownerGrants) return null;
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
            const frames = connection.frames;
            return {
              expiresAt: confirmed.expiresAt,
              connection: {
                initialFrame: connection.initialFrame,
                frames: (async function* () {
                  try {
                    yield* frames;
                  } finally {
                    signal.removeEventListener("abort", forwardAbort);
                    providerAbort.abort();
                  }
                })(),
              },
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
