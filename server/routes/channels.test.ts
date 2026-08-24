import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";

import { createFakeChannelConnector } from "../channels/fake.ts";
import { createChannelRegistrySync } from "../channels/registry.ts";
import { EventBus } from "../harness/bus.ts";
import { createChannelsService } from "../services/channels.ts";
import { createChannelsRoutes } from "./channels.ts";

function ctxFor(method: string, path: string) {
  const state = { status: 0, body: null as unknown };
  const res = {
    writeHead(code: number) {
      state.status = code;
      return res;
    },
    end(data?: string) {
      state.body = data ? JSON.parse(data) : null;
    },
  } as unknown as ServerResponse;
  const req = Readable.from([]) as unknown as IncomingMessage;
  return { ctx: { req, res, url: new URL(`http://127.0.0.1${path}`), path, method }, state };
}

describe("channel registry routes", () => {
  it("lists registered connectors and fetches one by id (read-only)", async () => {
    const connector = createFakeChannelConnector({ id: "fake-route" });
    const channels = createChannelsService({ registry: createChannelRegistrySync(), bus: new EventBus() });
    channels.register(connector);
    const routes = createChannelsRoutes({ channels });

    const listed = ctxFor("GET", "/api/channels");
    expect(await routes(listed.ctx)).toBe(true);
    expect(listed.state.status).toBe(200);
    expect(listed.state.body).toEqual({ connectors: [connector.status()] });

    const one = ctxFor("GET", "/api/channels/fake-route");
    expect(await routes(one.ctx)).toBe(true);
    expect(one.state.status).toBe(200);
    expect(one.state.body).toEqual({ connector: connector.status() });

    const missing = ctxFor("GET", "/api/channels/nope");
    expect(await routes(missing.ctx)).toBe(true);
    expect(missing.state.status).toBe(404);

    const write = ctxFor("POST", "/api/channels");
    expect(await routes(write.ctx)).toBe(false);
  });
});
