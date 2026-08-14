// Token resolution for the updater after P1.5: config.json holds a
// secret:// reference and the value is unsealed from secrets.json — via the
// injected safeStorage decryptor for keychain entries, or base64 for the
// documented file fallback. Canaries are constructed at runtime.
import { describe, expect, it } from "vitest";

import { readGithubToken, resolveSecretRef, tokenConfigured } from "./update-feed.mjs";

const token = () => ["fake", "gh", "canary", Date.now().toString(36), Math.random().toString(36).slice(2)].join("-");

const SEAL_PREFIX = "sealed\u0000";
const fakeDecrypt = (b: Buffer) => {
  const raw = b.toString("utf8");
  if (!raw.startsWith(SEAL_PREFIX)) throw new Error("bad ciphertext");
  return raw.slice(SEAL_PREFIX.length);
};
const sealedEntry = (value: string) => ({
  backend: "safeStorage",
  data: Buffer.from(SEAL_PREFIX + value, "utf8").toString("base64"),
});
const fileEntry = (value: string) => ({
  backend: "file",
  data: Buffer.from(value, "utf8").toString("base64"),
});

describe("readGithubToken with secret refs", () => {
  it("still reads a legacy plaintext token and prefers file over env", () => {
    const t = token();
    const text = JSON.stringify({ github: { token: t } });
    expect(readGithubToken({ GITHUB_TOKEN: "env-token" }, text)).toBe(t);
    expect(readGithubToken({ GITHUB_TOKEN: "env-token" }, "")).toBe("env-token");
  });

  it("resolves a keychain-sealed ref through the injected decryptor", () => {
    const t = token();
    const configText = JSON.stringify({ github: { token: "secret://github.token" } });
    const secretsText = JSON.stringify({ version: 1, entries: { "github.token": sealedEntry(t) } });
    expect(readGithubToken({}, configText, { fileText: secretsText, decrypt: fakeDecrypt })).toBe(t);
  });

  it("resolves a file-backend ref without any keychain", () => {
    const t = token();
    const configText = JSON.stringify({ github: { token: "secret://github.token" } });
    const secretsText = JSON.stringify({ version: 1, entries: { "github.token": fileEntry(t) } });
    expect(readGithubToken({}, configText, { fileText: secretsText })).toBe(t);
  });

  it("an unresolvable ref is unconfigured — env fallback still applies, never a throw", () => {
    const configText = JSON.stringify({ github: { token: "secret://github.token" } });
    // no secrets file at all
    expect(readGithubToken({}, configText)).toBe("");
    expect(tokenConfigured(readGithubToken({}, configText))).toBe(false);
    // sealed entry but no working decryptor (headless / locked keychain)
    const secretsText = JSON.stringify({ version: 1, entries: { "github.token": sealedEntry(token()) } });
    expect(readGithubToken({}, configText, { fileText: secretsText })).toBe("");
    expect(
      readGithubToken({}, configText, {
        fileText: secretsText,
        decrypt: () => {
          throw new Error("keychain locked");
        },
      }),
    ).toBe("");
    // env fallback still works when the file ref cannot be unsealed
    expect(readGithubToken({ GH_TOKEN: "env-fallback" }, configText, { fileText: secretsText })).toBe("env-fallback");
  });

  it("resolveSecretRef never throws on corrupt store files", () => {
    expect(resolveSecretRef("secret://github.token", { fileText: "{not json" })).toBe("");
    expect(resolveSecretRef("secret://github.token", { fileText: JSON.stringify({ entries: { "github.token": { backend: "file" } } }) })).toBe("");
    expect(resolveSecretRef("secret://missing", { fileText: JSON.stringify({ entries: {} }) })).toBe("");
  });
});
