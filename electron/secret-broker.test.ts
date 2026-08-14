// The pure half of the main-process safeStorage broker: one request message
// in, one reply out (or null for anything that isn't ours). safeStorage
// itself is injected, so the tests use a trivially reversible fake sealer —
// canaries are constructed at runtime, never credential-shaped literals.
import { describe, expect, it } from "vitest";

import { createSecretBrokerHandler } from "./secret-broker.mjs";

const SEAL_PREFIX = "sealed\u0000";
const handler = createSecretBrokerHandler({
  encryptString: (s: string) => Buffer.from(SEAL_PREFIX + s, "utf8"),
  decryptString: (b: Buffer) => {
    const raw = b.toString("utf8");
    if (!raw.startsWith(SEAL_PREFIX)) throw new Error("bad ciphertext");
    return raw.slice(SEAL_PREFIX.length);
  },
});

describe("secret broker handler", () => {
  it("round-trips encrypt → decrypt through the message protocol", () => {
    const value = ["fake", "broker", "canary", Date.now().toString(36)].join("-");
    const sealed = handler({ velarixSecrets: true, id: 1, op: "encrypt", data: value });
    expect(sealed).toMatchObject({ velarixSecrets: true, id: 1, ok: true });
    expect(sealed.data).not.toContain(value); // base64 ciphertext, not the value

    const opened = handler({ velarixSecrets: true, id: 2, op: "decrypt", data: sealed.data });
    expect(opened).toEqual({ velarixSecrets: true, id: 2, ok: true, data: value });
  });

  it("ignores messages that are not secret-broker requests", () => {
    expect(handler(null)).toBeNull();
    expect(handler("hello")).toBeNull();
    expect(handler({ id: 3, op: "encrypt", data: "x" })).toBeNull(); // no marker
    expect(handler({ velarixSecrets: true, op: "encrypt", data: "x" })).toBeNull(); // no id
  });

  it("answers unknown ops and crypto failures with generic errors — never values", () => {
    const unknown = handler({ velarixSecrets: true, id: 4, op: "rotate", data: "x" });
    expect(unknown).toEqual({ velarixSecrets: true, id: 4, ok: false, error: "unknown op" });

    const value = ["fake", "fail", "canary", Date.now().toString(36)].join("-");
    const bad = handler({
      velarixSecrets: true,
      id: 5,
      op: "decrypt",
      data: Buffer.from(value, "utf8").toString("base64"), // not our ciphertext
    });
    expect(bad).toEqual({ velarixSecrets: true, id: 5, ok: false, error: "decrypt failed" });
    expect(JSON.stringify(bad)).not.toContain(value);
  });
});
