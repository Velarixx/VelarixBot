// Registry rules: local is core, box is bundled-but-optional, an authored
// providers map replaces the default (dropping Box is config, not surgery),
// legacy "cloud" aliases the box binding, and a broken/unknown entry
// degrades to an unavailable shadow provider instead of crashing boot.
import { describe, expect, it } from "vitest";

import { computerProviderConfigs, createComputerRegistry } from "./registry.ts";

describe("computerProviderConfigs", () => {
  it("defaults to the bundled box provider plus core local", () => {
    expect(computerProviderConfigs({})).toEqual({ box: { kind: "box" }, local: { kind: "local" } });
  });

  it("an authored providers map — even empty — replaces the bundled default", () => {
    expect(computerProviderConfigs({ computer: { providers: {} } })).toEqual({ local: { kind: "local" } });
    expect(computerProviderConfigs({ computer: { providers: { fake: { kind: "fake" } } } })).toEqual({
      fake: { kind: "fake" },
      local: { kind: "local" },
    });
  });

  it("reserves the off/cloud binding names", () => {
    const map = computerProviderConfigs({
      computer: { providers: { off: { kind: "fake" }, cloud: { kind: "fake" } } },
    });
    expect(map.off).toBeUndefined();
    expect(map.cloud).toBeUndefined();
  });
});

describe("createComputerRegistry", () => {
  it("registers local + box by default and resolves the legacy cloud alias", async () => {
    const registry = await createComputerRegistry({ cfg: {} });
    expect(registry.get("local")?.kind).toBe("local");
    expect(registry.get("box")?.kind).toBe("box");
    expect(registry.resolveBinding("off")).toBe("off");
    expect(registry.resolveBinding("")).toBe("off");
    expect(registry.resolveBinding(undefined)).toBe("off");
    expect(registry.resolveBinding("cloud")).toBe("box");
    expect(registry.resolveBinding("box")).toBe("box");
    expect(registry.resolveBinding("local")).toBe("local");
    expect(registry.resolveBinding("e2b")).toBeNull();
    expect(registry.defaultRemote()?.id).toBe("box");
  });

  it("drops Box via config while local stays intact", async () => {
    const registry = await createComputerRegistry({ cfg: { computer: { providers: {} } } });
    expect(registry.get("box")).toBeNull();
    expect(registry.resolveBinding("cloud")).toBeNull();
    expect(registry.resolveBinding("box")).toBeNull();
    expect(registry.defaultRemote()).toBeNull();
    // local is core — registered regardless of the authored map
    expect(registry.get("local")?.kind).toBe("local");
    expect(registry.resolveBinding("local")).toBe("local");
  });

  it("registers a configured fake provider as the remote default when box is gone", async () => {
    const registry = await createComputerRegistry({ cfg: { computer: { providers: { fake: { kind: "fake" } } } } });
    expect(registry.get("fake")?.kind).toBe("fake");
    expect(registry.defaultRemote()?.id).toBe("fake");
    expect(registry.resolveBinding("cloud")).toBeNull(); // the alias means box, nothing else
  });

  it("downgrades an unknown provider kind to an unavailable shadow", async () => {
    const registry = await createComputerRegistry({
      cfg: { computer: { providers: { weird: { kind: "e2b" } } } },
    });
    const shadow = registry.get("weird");
    expect(shadow).not.toBeNull();
    expect(Object.values(shadow!.capabilities).every((c) => c === false)).toBe(true);
    const status = await shadow!.status("bot-x");
    expect(status.configured).toBe(false);
    expect(status.reason).toMatch(/unknown computer provider kind "e2b"/);
    await expect(shadow!.provision({ id: "bot-x", name: "X" })).rejects.toThrow(/unknown computer provider kind/);
    // a bot BOUND to the shadow still resolves — it just can't act
    expect(registry.resolveBinding("weird")).toBe("weird");
  });

  it("downgrades a config-decode failure to a shadow with the decode reason", async () => {
    const registry = await createComputerRegistry({
      cfg: { computer: { providers: { box: { kind: "box", config: { url: 42 } } } } },
    });
    const shadow = registry.get("box");
    expect(shadow).not.toBeNull();
    const status = await shadow!.status("bot-x");
    expect(status.configured).toBe(false);
    expect(status.reason).toMatch(/url must be a non-empty string/);
  });
});
