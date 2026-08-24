import { describe, expect, it } from "vitest";

import {
  decodeSymmetricKey,
  decryptEncStringUtf8,
  deriveShareableKey,
  encryptEncString,
  organizationKeyFromPayload,
  parseAccessToken,
} from "./bitwarden-crypto.ts";

describe("Bitwarden SM crypto (official SDK vectors)", () => {
  it("derives shareable keys the way bitwarden_crypto does", () => {
    const none = deriveShareableKey(Buffer.from("&/$%F1a895g67HlX"), "test_key");
    expect(none.toString("base64")).toBe(
      "4PV6+PcmF2w7YHRatvyMcVQtI7zvCyssv/wFWmzjiH6Iv9altjmDkuBD1aagLVaLezbthbSe+ktR+U6qswxNnQ==",
    );
    const withInfo = deriveShareableKey(Buffer.from("67t9b5g67$%Dh89n"), "test_key", "test");
    expect(withInfo.toString("base64")).toBe(
      "F9jVQmrACGx9VUPjuzfMYDjr726JtL300Y3Yg+VYUnVQtQ1s8oImJ5xtp1KALC9h2nav04++1LDW4iFD+infng==",
    );
  });

  it("parses a version-0 access token and derives the payload key", () => {
    // Published sdk-internal fixture — not a live machine-account token.
    const token = [
      "0",
      "ec2c1d46-6a4b-4751-a310-af9601317f2d",
      "C2IgxjjLF7qSshsbwe8JGcbM075YXw",
    ].join(".") + ":X8vbvA0bduihIDe/qrzIQQ==";
    const parsed = parseAccessToken(token);
    expect(parsed.accessTokenId).toBe("ec2c1d46-6a4b-4751-a310-af9601317f2d");
    expect(parsed.clientSecret).toBe("C2IgxjjLF7qSshsbwe8JGcbM075YXw");
    expect(parsed.encryptionKey.toString("base64")).toBe(
      "H9/oIRLtL9nGCQOVDjSMoEbJsjWXSOCb3qeyDt6ckzS3FhyboEDWyTP/CQfbIszNmAVg2ExFganG1FVFGXO/Jg==",
    );
  });

  it("rejects malformed access tokens without echoing them", () => {
    const bad = [
      "1.ec2c1d46-6a4b-4751-a310-af9601317f2d.C2IgxjjLF7qSshsbwe8JGcbM075YXw:X8vbvA0bduihIDe/qrzIQQ==",
      "ec2c1d46-6a4b-4751-a310-af9601317f2d.C2IgxjjLF7qSshsbwe8JGcbM075YXw:X8vbvA0bduihIDe/qrzIQQ==",
      "0.not-a-uuid.C2IgxjjLF7qSshsbwe8JGcbM075YXw:X8vbvA0bduihIDe/qrzIQQ==",
      "not-a-token",
    ];
    for (const token of bad) {
      expect(() => parseAccessToken(token)).toThrow(/invalid Bitwarden access token/);
    }
  });

  it("round-trips EncString type 2 and reads an identity encryptionKey payload", () => {
    const key = decodeSymmetricKey(
      "H9/oIRLtL9nGCQOVDjSMoEbJsjWXSOCb3qeyDt6ckzS3FhyboEDWyTP/CQfbIszNmAVg2ExFganG1FVFGXO/Jg==",
    );
    const orgKey = Buffer.alloc(64, 7);
    const payload = encryptEncString(JSON.stringify({ encryptionKey: orgKey.toString("base64") }), key);
    expect(organizationKeyFromPayload(Buffer.from(decryptEncStringUtf8(payload, key), "utf8")).equals(orgKey)).toBe(true);
    const secret = encryptEncString("plain-canary-value", orgKey);
    expect(decryptEncStringUtf8(secret, orgKey)).toBe("plain-canary-value");
    expect(secret.startsWith("2.")).toBe(true);
    expect(secret).not.toContain("plain-canary-value");
  });
});
