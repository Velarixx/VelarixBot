import { describe, expect, it } from "vitest";

import { instanceConfigs } from "./config.ts";

describe("instanceConfigs", () => {
  it("includes OpenRouter and OmniRouter on the default fleet, unavailable until keyed", () => {
    const map = instanceConfigs({});
    expect(map.openrouter).toMatchObject({ driver: "openrouter" });
    expect(map.omnirouter).toMatchObject({ driver: "omnirouter" });
    expect(map.openrouter.environment?.OPENROUTER_API_KEY).toBeUndefined();
  });

  it("injects write-only keys into instance env and keeps a custom URL", () => {
    const map = instanceConfigs({
      openrouter: { key: "sk-or-v1-secret", url: "http://127.0.0.1:9/v1" },
      omnirouter: { key: "omni-secret" },
      instances: { ghost: { driver: "not-a-real-driver" } },
    });
    expect(map.ghost.driver).toBe("not-a-real-driver");
    expect(map.openrouter.environment?.OPENROUTER_API_KEY).toBe("sk-or-v1-secret");
    expect(map.omnirouter.environment?.OMNIROUTER_API_KEY).toBe("omni-secret");
    expect((map.openrouter.config as { url?: string }).url).toBe("http://127.0.0.1:9/v1");
  });
});
