import { describe, expect, it } from "vitest";
import { createRestartPolicy } from "./server-supervisor.mjs";

describe("createRestartPolicy", () => {
  it("allows up to maxRestarts inside the window, then gives up", () => {
    let t = 0;
    const policy = createRestartPolicy({ maxRestarts: 3, windowMs: 60_000, now: () => t });
    expect(policy.shouldRestart()).toBe(true);
    expect(policy.shouldRestart()).toBe(true);
    expect(policy.shouldRestart()).toBe(true);
    expect(policy.shouldRestart()).toBe(false); // crash loop — stop flapping
    expect(policy.shouldRestart()).toBe(false);
  });

  it("forgets attempts that fall out of the window (slow, occasional deaths keep respawning)", () => {
    let t = 0;
    const policy = createRestartPolicy({ maxRestarts: 2, windowMs: 60_000, now: () => t });
    expect(policy.shouldRestart()).toBe(true);
    t += 61_000;
    expect(policy.shouldRestart()).toBe(true);
    t += 61_000;
    expect(policy.shouldRestart()).toBe(true);
    // two quick deaths inside one window still hit the cap
    expect(policy.shouldRestart()).toBe(true);
    expect(policy.shouldRestart()).toBe(false);
  });

  it("defaults are sane without arguments", () => {
    const policy = createRestartPolicy();
    expect(policy.shouldRestart()).toBe(true);
  });
});
