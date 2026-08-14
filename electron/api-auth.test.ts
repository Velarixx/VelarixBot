// The pure half of the launch-token injection: main mints one token per
// launch, forwards it to the forked server via env, and injects it on every
// renderer request to the server origin — including EventSource/SSE, which
// cannot set its own headers. The filter is built from the FINAL port after
// fallback, so the UI keeps working when 8799 was taken.
import { describe, expect, it } from "vitest";

import { mintApiToken, serverUrlFilter, withAuthHeader } from "./api-auth.mjs";

describe("api-auth helpers", () => {
  it("mints a unique 256-bit hex token per launch", () => {
    const a = mintApiToken();
    const b = mintApiToken();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });

  it("scopes the webRequest filter to the fallback port actually bound", () => {
    expect(serverUrlFilter(8799)).toEqual(["http://127.0.0.1:8799/*"]);
    expect(serverUrlFilter(18799)).toEqual(["http://127.0.0.1:18799/*"]);
    expect(serverUrlFilter(28799)).toEqual(["http://127.0.0.1:28799/*"]);
  });

  it("injects the Authorization header without dropping existing headers", () => {
    const headers = withAuthHeader({ Accept: "text/event-stream" }, "tok");
    expect(headers).toEqual({ Accept: "text/event-stream", Authorization: "Bearer tok" });
  });
});
