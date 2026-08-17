// Shared-box guards on the computer routes: suspend is refused while
// another bot holds (or queues on) the machine lease, the panel status
// carries shared / inUseBy, and the migration cleanup endpoints stay
// confirm-shaped (explicit ids, explicit failures). Fake provider, fake
// broker — no vendors, no HTTP server.
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";

import { createLeaseBroker } from "../computer/leases.ts";
import type { ComputerProvider } from "../computer/provider.ts";
import type { ComputerRegistry } from "../computer/registry.ts";
import type { BotsService } from "../services/bots.ts";
import { createComputersRoutes } from "./computers.ts";

const MACHINE = "m-shared";

function fakeProvider(): ComputerProvider {
  return {
    id: "box",
    kind: "box",
    displayName: "Cloud box",
    capabilities: { exec: true, screenshot: true, files: true, desktopUrl: true, suspend: true, destroy: false, mcp: true },
    turnPrompt: "",
    status: async () => ({ configured: true, machine: { id: MACHINE, state: "running" } }),
    provision: async () => ({ machineId: MACHINE, reused: true, state: "running" }),
    // eslint-disable-next-line require-yield
    async *execute() {
      throw new Error("unused");
    },
    connectScreen: async () => ({ kind: "url", url: "fake://desktop" }),
    suspend: async () => {},
    destroy: async () => {
      throw new Error("unsupported");
    },
    screenshot: async () => ({ png: "cGc=", format: "png" }),
    readFile: async () => ({ content: "cGc=", path: "/x" }),
    mcpIntegration: async () => null,
  };
}

function registryOf(provider: ComputerProvider): ComputerRegistry {
  return {
    get: (id) => (id === provider.id ? provider : null),
    list: () => [provider],
    resolveBinding: (value) => (value === "off" ? "off" : provider.id),
    defaultRemote: () => provider,
  };
}

const botsOf = (bots: Record<string, { computer?: string }>): BotsService =>
  ({ bot: (id: string) => (bots[id] ? { id, name: id, ...bots[id] } : undefined) }) as unknown as BotsService;

function ctxFor(method: string, path: string, body?: unknown) {
  const state = { status: 0, body: null as any };
  const res = {
    writeHead(code: number) {
      state.status = code;
      return res;
    },
    end(data?: string) {
      state.body = data ? JSON.parse(data) : null;
    },
  } as unknown as ServerResponse;
  const req = (body !== undefined ? Readable.from([JSON.stringify(body)]) : Readable.from([])) as unknown as IncomingMessage;
  return { ctx: { req, res, url: new URL(`http://x${path}`), path, method }, state };
}

describe("suspend guard on a leased machine", () => {
  it("refuses sleep while ANOTHER bot holds the lease, allows it for the holder / when free", async () => {
    const leases = createLeaseBroker();
    await leases.acquire(`box:${MACHINE}`, { id: "ada", name: "Ada" });
    const routes = createComputersRoutes({
      bots: botsOf({ ada: { computer: "box" }, bea: { computer: "box" } }),
      computers: registryOf(fakeProvider()),
      recordBinding: () => {},
      leases,
    });

    const denied = ctxFor("POST", "/api/bots/bea/computer/sleep");
    expect(await routes(denied.ctx)).toBe(true);
    expect(denied.state.status).toBe(409);
    expect(denied.state.body.error).toBe("in use by Ada");

    // the HOLDER may park its own machine (nobody else is queued)
    const own = ctxFor("POST", "/api/bots/ada/computer/sleep");
    expect(await routes(own.ctx)).toBe(true);
    expect(own.state.status).toBe(200);

    leases.release(`box:${MACHINE}`, "ada");
    const free = ctxFor("POST", "/api/bots/bea/computer/sleep");
    expect(await routes(free.ctx)).toBe(true);
    expect(free.state.status).toBe(200);
  });

  it("panel status reports shared and who is using the machine", async () => {
    const leases = createLeaseBroker();
    await leases.acquire(`box:${MACHINE}`, { id: "ada", name: "Ada" });
    const routes = createComputersRoutes({
      bots: botsOf({ ada: { computer: "box" }, bea: { computer: "box" } }),
      computers: registryOf(fakeProvider()),
      recordBinding: () => {},
      leases,
      isShared: () => true,
    });
    const bea = ctxFor("GET", "/api/bots/bea/computer");
    await routes(bea.ctx);
    expect(bea.state.body).toMatchObject({ configured: true, shared: true, inUseBy: "Ada" });
    const ada = ctxFor("GET", "/api/bots/ada/computer");
    await routes(ada.ctx);
    expect(ada.state.body.shared).toBe(true);
    expect(ada.state.body.inUseBy).toBeUndefined();
  });
});

describe("migration cleanup endpoints", () => {
  const stale = [{ id: "a1", name: "velarixbot-workspace-bot-a", state: "archived" }];

  it("lists and destroys with explicit ids; missing ids are a 400", async () => {
    const destroyedWith: string[][] = [];
    const routes = createComputersRoutes({
      bots: botsOf({}),
      computers: registryOf(fakeProvider()),
      recordBinding: () => {},
      cleanup: {
        list: async () => stale,
        destroy: async (ids) => {
          destroyedWith.push(ids);
          return { destroyed: [{ id: "a1", name: stale[0].name }], failed: [] };
        },
      },
    });

    const list = ctxFor("GET", "/api/computer/cleanup");
    await routes(list.ctx);
    expect(list.state.body).toEqual({ boxes: stale });

    const destroy = ctxFor("POST", "/api/computer/cleanup", { boxIds: ["a1"] });
    await routes(destroy.ctx);
    expect(destroy.state.status).toBe(200);
    expect(destroy.state.body.destroyed).toHaveLength(1);
    expect(destroyedWith).toEqual([["a1"]]);

    const empty = ctxFor("POST", "/api/computer/cleanup", {});
    await routes(empty.ctx);
    expect(empty.state.status).toBe(400);
  });

  it("is a 409 when no provider offers cleanup", async () => {
    const routes = createComputersRoutes({
      bots: botsOf({}),
      computers: registryOf(fakeProvider()),
      recordBinding: () => {},
    });
    const list = ctxFor("GET", "/api/computer/cleanup");
    await routes(list.ctx);
    expect(list.state.status).toBe(409);
  });
});
