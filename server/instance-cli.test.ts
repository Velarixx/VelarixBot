// Per-engine CLI path: PATCH /api/instances/:id { cli } is the user-facing
// API. A partial instances map must not wipe the default fleet.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { bootHarness, type BootedHarness } from "./testing/harness.ts";

let h: BootedHarness;

beforeAll(async () => {
  // Empty authored map → persistableFleet uses the default fleet.
  h = await bootHarness({ instances: {} });
}, 30_000);

afterAll(async () => {
  await h?.stop();
});

describe("PATCH /api/instances/:id cli", () => {
  it("sets an instance CLI path, keeps the rest of the fleet, and clears on empty", async () => {
    const before = await h.api("GET", "/api/instances");
    expect(before.status).toBe(200);
    const ids = (before.body.instances as Array<{ instanceId: string }>).map((i) => i.instanceId);
    expect(ids).toEqual(expect.arrayContaining(["claude", "codex", "gemini", "grok", "hermes"]));

    const patched = await h.api("PATCH", "/api/instances/claude", { cli: "/opt/custom/claude" });
    expect(patched.status).toBe(200);
    const claude = patched.body.instances.find((i: { instanceId: string }) => i.instanceId === "claude");
    expect(claude?.cli).toBe("/opt/custom/claude");
    const afterIds = (patched.body.instances as Array<{ instanceId: string }>).map((i) => i.instanceId);
    expect(afterIds).toEqual(expect.arrayContaining(ids));

    const again = await h.api("GET", "/api/instances");
    expect(again.body.instances.find((i: { instanceId: string }) => i.instanceId === "claude")?.cli).toBe(
      "/opt/custom/claude",
    );

    const cleared = await h.api("PATCH", "/api/instances/claude", { cli: "  " });
    expect(cleared.status).toBe(200);
    expect(cleared.body.instances.find((i: { instanceId: string }) => i.instanceId === "claude")?.cli).toBe("claude");
  });

  it("404s an unknown instance and 400s a non-string cli", async () => {
    const missing = await h.api("PATCH", "/api/instances/not-an-engine", { cli: "/opt/x" });
    expect(missing.status).toBe(404);
    const bad = await h.api("PATCH", "/api/instances/claude", { cli: 7 });
    expect(bad.status).toBe(400);
  });

  it("does not accept instances on PUT /api/config", async () => {
    const res = await h.api("PUT", "/api/config", {
      instances: { onlyMine: { driver: "codex", config: { cli: "/tmp/wipe" } } },
    });
    expect(res.status).toBe(400);
    const fleet = await h.api("GET", "/api/instances");
    expect(fleet.body.instances.some((i: { instanceId: string }) => i.instanceId === "onlyMine")).toBe(false);
    expect(fleet.body.instances.some((i: { instanceId: string }) => i.instanceId === "claude")).toBe(true);
  });
});
